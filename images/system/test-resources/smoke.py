#!/usr/bin/env python3
"""Run on the disposable Linux Docker host: smoke.py SYSTEM_IMAGE APP_TAR STRESS_BINARY.
The System fixture is isolated from the installation. No UI tests or host tuning.
"""
import concurrent.futures, json, os, pathlib, subprocess, sys, tempfile, threading, time, urllib.request
name = 'atelier-resource-test'
image, archive, stress = sys.argv[1:]
containers = []
monitor_stop=threading.Event(); monitor_errors=[]; monitor_times=[]
def monitor():
    while not monitor_stop.is_set():
        try:
            start=time.monotonic(); assert fetch()['healthy']; assert fetch('/state',app=True)['ready']; monitor_times.append(time.monotonic()-start)
        except Exception as error: monitor_errors.append(str(error))
        monitor_stop.wait(.1)
monitor_thread=None

def run(*args, check=True, **kwargs):
    return subprocess.run(args, check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs).stdout.decode().strip()
def docker(*args, **kwargs): return run('docker', *args, **kwargs)
def inner(*args, **kwargs): return docker('exec', name, 'docker', *args, **kwargs)
def fetch(path='/status', data=None, app=False):
    url = ('http://127.0.0.1:'+ports[3000 if app else 3001])+path
    request = urllib.request.Request(url, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request, timeout=3) as response: return json.load(response)
def until(test, seconds=120):
    deadline = time.monotonic()+seconds
    while time.monotonic()<deadline:
        try:
            result=test()
            if result:return result
        except (OSError, subprocess.CalledProcessError):pass
        time.sleep(.25)
    raise AssertionError('timeout waiting for condition')
def read(group, file): return pathlib.Path(group,file).read_text().strip()
def stat(group,file): return dict(line.split() for line in read(group,file).splitlines())
def sample(seconds=5):
    times=[];deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        start=time.monotonic();assert fetch()['healthy'];assert fetch('/state',app=True)['ready'];times.append(time.monotonic()-start);time.sleep(.05)
    worst=max(times); print('endpoint pair worst latency',round(worst,3),'seconds',flush=True);assert worst<3
    return worst
def workload(label, mode, *args, parent=None):
    cname=f'{name}-{label}';containers.append(cname)
    inner('run','-d','--name',cname,*(['--cgroup-parent',parent] if parent else []),'--mount',f'type=volume,src={cname},dst=/data','atelier-resource-stress',mode,*args)
    return cname
def remove(cname):inner('rm','-f',cname);containers.remove(cname);inner('volume','rm',cname)
def scan_probe():
    for path in pathlib.Path(workloads).rglob('cgroup.procs'):
        for pid in path.read_text().split():
            try:
                if b'/stress\x00probe' in pathlib.Path('/proc',pid,'cmdline').read_bytes():return str(path)
            except FileNotFoundError:pass
    return False
try:
    docker('run','-d','--name',name,'--privileged','--cgroupns=host','--memory=3g','--pids-limit=4096','--cpuset-cpus',str(min(os.sched_getaffinity(0))),'--tmpfs','/run','--mount',f'source={name},target=/data','-p','127.0.0.1::3000','-p','127.0.0.1::3001',image,'--app-image','atelier-test:v2')
    info=json.loads(docker('inspect',name))[0]
    os.setns(os.open(f"/proc/{info['State']['Pid']}/ns/net", os.O_RDONLY), os.CLONE_NEWNET)
    ports={3000:'3000',3001:'3001'}
    until(lambda:inner('info','--format','{{.CgroupDriver}}')=='cgroupfs')
    with open(archive,'rb') as file: subprocess.run(['docker','exec','-i',name,'docker','load'],stdin=file,check=True,stdout=subprocess.DEVNULL)
    until(lambda:not fetch()['busy'])
    fetch('/update',{'image':'atelier-test:v2'});until(lambda:fetch()['healthy'])
    config=json.loads(docker('exec',name,'cat','/run/atelier-system/resources.json'))
    workloads='/sys/fs/cgroup'+config['workloadsCgroupParent'];management=str(pathlib.Path(workloads).parent/'management')
    print('resource policy',config,flush=True)
    assert config['effectiveMemory']==3*1024**3
    assert read(workloads,'memory.max')==str(2*1024**3)
    assert read(workloads,'pids.max')=='3072'
    assert read(workloads,'cpu.max').startswith('max ')
    assert read(workloads,'cpu.weight')=='100' and read(management,'cpu.weight')=='1000'
    app_id=inner('inspect','--format','{{.Id}}','atelier')
    assert inner('inspect','--format','{{.HostConfig.CgroupParent}}','atelier')==config['managementCgroupParent']
    moved=inner('exec','--user','1000','atelier','sh','-ec','echo $$ > /run/atelier-system/workload-processes/cgroup.procs; cat /proc/self/cgroup')
    assert config['workloadsCgroupParent']+'/commands' in moved
    assert '/management/apps/' in inner('exec','atelier','cat','/proc/self/cgroup')
    with tempfile.TemporaryDirectory() as directory:
        pathlib.Path(directory,'Dockerfile').write_text('FROM atelier-test:v2\nCOPY stress /stress\nENTRYPOINT ["/stress"]\n')
        import shutil;shutil.copy(stress,pathlib.Path(directory,'stress'))
        docker('exec',name,'mkdir','-p','/tmp/resource-build')
        docker('cp',directory+'/.',name+':/tmp/resource-build')
        inner('build','--cgroup-parent',config['workloadsCgroupParent'],'-t','atelier-resource-stress','/tmp/resource-build')
    sample(2)
    monitor_thread=threading.Thread(target=monitor);monitor_thread.start()
    with concurrent.futures.ThreadPoolExecutor() as executor:
        build=executor.submit(lambda: subprocess.run(['docker','exec','-i',name,'docker','build','--no-cache','--cgroup-parent',config['workloadsCgroupParent'],'-t','atelier-resource-probe','-'],input=b'FROM atelier-resource-stress\nRUN /stress probe\n',check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE))
        print('build RUN membership',until(scan_probe,20),flush=True);build.result()
    print('CPU saturation',flush=True)
    workers=[workload(f'cpu{i}','cpu') for i in range(4)]
    idle_start=int(stat(workloads,'cpu.stat')['usage_usec'])
    sample(8)
    idle_used=int(stat(workloads,'cpu.stat')['usage_usec'])-idle_start
    print('Idle management: workloads CPU usec over 8s',idle_used,flush=True);assert idle_used>5_000_000
    manager=workload('management-cpu','cpu',parent=config['managementCgroupParent'])
    before={g:int(stat(g,'cpu.stat')['usage_usec']) for g in (management,workloads)}
    time.sleep(8)
    used={g:int(stat(g,'cpu.stat')['usage_usec'])-before[g] for g in before}
    print('CPU management/workloads usec',used,flush=True);assert used[management]>used[workloads]*3
    for c in workers+[manager]:remove(c)
    print('Collective memory OOM',flush=True)
    before=int(stat(workloads,'memory.events')['oom_kill']); high_before=int(stat(workloads,'memory.events')['high'])
    workers=[workload(f'memory{i}','memory','1000') for i in range(3)]
    until(lambda:int(stat(workloads,'memory.events')['high'])>high_before,40);sample(3)
    print('memory.high pressure verified; temporarily lift soft threshold to exercise hard ceiling promptly',flush=True)
    pathlib.Path(workloads,'memory.high').write_text('max')
    until(lambda:int(stat(workloads,'memory.events')['oom_kill'])>before,40);sample(3)
    for c in workers:remove(c)
    pathlib.Path(workloads,'memory.high').write_text(str(config['policy']['memoryHigh']))
    print('Collective process exhaustion',flush=True)
    before=int(stat(workloads,'pids.events')['max'])
    workers=[workload('pids-a','pids','1500'),workload('pids-b','pids','2000')]
    until(lambda:int(stat(workloads,'pids.events')['max'])>before,30);sample(3)
    for c in workers:remove(c)
    print('Concurrent synchronous disk IO (weights depend on host scheduler)',flush=True)
    workers=[workload(f'io{i}','io') for i in range(2)];sample(8)
    print('workload io.stat',read(workloads,'io.stat'),flush=True)
    for c in workers:remove(c)
    assert inner('inspect','--format','{{.Id}}','atelier')==app_id
    assert fetch()['healthy']
    monitor_stop.set();monitor_thread.join();monitor_thread=None
    assert not monitor_errors,monitor_errors
    print('Continuous endpoint samples',len(monitor_times),'worst',round(max(monitor_times),3),'seconds',flush=True)
    print('PASS resource containment and management responsiveness',flush=True)
finally:
    monitor_stop.set()
    if monitor_thread:monitor_thread.join()
    for c in containers:inner('rm','-f',c,check=False)
    docker('rm','-f',name,check=False);docker('volume','rm',name,check=False)
