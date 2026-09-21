#!/usr/bin/env python3
"""Linux Docker host: firewall-smoke.py SYSTEM_IMAGE APP_TAR.
Uses an isolated System and isolated outer uplink. Public address ranges below
are test routes confined to that uplink, not traffic to the real address owners.
"""
import json,pathlib,subprocess,sys,tempfile,time
image,archive=sys.argv[1:]
name='atelier-firewall-test';uplink=name+'-uplink';endpoint=name+'-endpoint'
workers=[]
def run(*args,check=True,**kwargs):
 p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)
 if check and p.returncode:raise RuntimeError(' '.join(args)+'\n'+p.stderr.decode())
 return p
def docker(*args,**kwargs):return run('docker',*args,**kwargs)
def system(*args,**kwargs):return docker('exec',name,*args,**kwargs)
def inner(*args,**kwargs):return system('docker',*args,**kwargs)
def until(test,seconds=90):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  try:
   if test():return
  except RuntimeError:pass
  time.sleep(.25)
 raise AssertionError('condition timed out')
def jsfetch(url):return 'console.log(await(await fetch('+json.dumps(url)+',{signal:AbortSignal.timeout(1200)})).text())'
def query(worker,url,allowed=True):
 p=inner('exec',worker,'bun','-e',jsfetch(url),check=False)
 assert (p.returncode==0)==allowed,(worker,url,p.stdout.decode(),p.stderr.decode())
 return p.stdout.decode().strip()
def sysquery(url):return system('bun','-e',jsfetch(url)).stdout.decode().strip()
def policy():return system('nft','-s','list','table','inet','atelier_workspaces').stdout.decode()
def drops():
 entries=json.loads(system('nft','-j','list','table','inet','atelier_workspaces').stdout)['nftables'];total=0
 for entry in entries:
  rule=entry.get('rule',{});expressions=rule.get('expr',[])
  if any('drop' in e for e in expressions):total+=sum(e.get('counter',{}).get('packets',0) for e in expressions)
 return total
def serve_script(text):return 'Bun.serve({hostname:"::",port:8080,fetch:()=>new Response('+json.dumps(text)+')})'
def create_worker(number):
 net=f'firewall-workspace-{number}';worker=f'fw-workspace-{number}'
 inner('network','create','--ipv6','--subnet',f'172.28.{number}.0/24','--subnet',f'fd12:3456:{number}::/64','--opt',f'com.docker.network.bridge.name=atw-test{number}',net)
 inner('run','-d','--name',worker,'--network',net,'--entrypoint','bun','--mount','type=bind,src=/data/firewall-uds,dst=/run/atelier-parent,readonly',image,'-e',serve_script(worker));workers.append(worker)
 info=json.loads(inner('inspect',worker).stdout)[0]['NetworkSettings']['Networks'][net]
 until(lambda:sysquery(f'http://{info["IPAddress"]}:8080')==worker)
 return worker,info
try:
 # Failure must stop System before Docker can restore any workspaces.
 with tempfile.TemporaryDirectory(prefix='atelier-firewall-') as directory:
  executable=pathlib.Path(directory)/'nft'
  executable.write_text('#!/bin/sh\necho simulated-nft-failure >&2\nexit 23\n');executable.chmod(0o755)
  failed=docker('run','--rm','--privileged','--cgroupns=host','--tmpfs','/run','--mount',f'type=bind,src={executable},dst=/usr/sbin/nft,readonly',image,'--app-image','atelier-test:v2',check=False)
  assert failed.returncode==1 and b'Could not install workspace firewall: simulated-nft-failure' in failed.stdout+failed.stderr
 print('PASS firewall install failure stops System explicitly',flush=True)
 docker('network','create','--ipv6','--subnet','11.200.0.0/24','--subnet','2001:4860:ffff:dead::/64',uplink)
 docker('run','-d','--name',endpoint,'--network',uplink,'--ip','11.200.0.2','--ip6','2001:4860:ffff:dead::2','--cap-add','NET_ADMIN','--entrypoint','bun',image,'-e',serve_script('external'))
 for address in ('10.200.0.2/32','100.64.0.2/32','fd99::2/128','fd7a:115c:a1e0::2/128'):
  docker('exec',endpoint,'ip','addr','add',address,'dev','eth0')
 docker('run','-d','--name',name,'--privileged','--cgroupns=host','--restart','unless-stopped','--network',uplink,'--ip','11.200.0.3','--ip6','2001:4860:ffff:dead::3','--tmpfs','/run','--mount',f'source={name},target=/data',image,'--app-image','atelier-test:v2')
 until(lambda:inner('info',check=False).returncode==0)
 # Reuse actual built image locally, no registry credentials needed.
 source=subprocess.Popen(['docker','save',image],stdout=subprocess.PIPE)
 docker('exec','-i',name,'docker','load',stdin=source.stdout);assert source.wait()==0
 with open(archive,'rb') as file:docker('exec','-i',name,'docker','load',stdin=file)
 until(lambda:not json.loads(sysquery('http://127.0.0.1:3001/status'))['busy'])
 system('bun','-e','await fetch("http://127.0.0.1:3001/update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({image:"atelier-test:v2"})})')
 until(lambda:json.loads(sysquery('http://127.0.0.1:3001/status'))['healthy'])
 system('mkdir','-p','/data/firewall-uds')
 def setup_routes_and_socket():
  for target in ('10.200.0.2/32','100.64.0.2/32'):system('ip','route','replace',target,'via','11.200.0.2')
  for target in ('fd99::2/128','fd7a:115c:a1e0::2/128'):system('ip','-6','route','replace',target,'via','2001:4860:ffff:dead::2')
  docker('exec','-d',name,'bun','-e',serve_script('system-only'))
  system('rm','-f','/data/firewall-uds/parent.sock')
  docker('exec','-d',name,'bun','-e','Bun.serve({unix:"/data/firewall-uds/parent.sock",fetch:()=>new Response("parent-socket")})')
 setup_routes_and_socket()
 a,ai=create_worker(1);b,bi=create_worker(2)
 before=policy()
 def checks(worker,info,peer):
  start=drops()
  assert query(worker,'http://11.200.0.2:8080')=='external'
  assert query(worker,'http://[2001:4860:ffff:dead::2]:8080')=='external'
  query(worker,'https://example.com') # actual public DNS + HTTPS, Docker NAT
  for host in (info['Gateway'],info['IPv6Gateway']):
   url=f'http://[{host}]:8080' if ':' in host else f'http://{host}:8080'
   assert sysquery(url)=='system-only';query(worker,url,False)
  for ip in (peer['IPAddress'],peer['GlobalIPv6Address']):query(worker,f'http://[{ip}]:8080' if ':' in ip else f'http://{ip}:8080',False)
  for ip in ('10.200.0.2','100.64.0.2','fd99::2','fd7a:115c:a1e0::2'):
   url=f'http://[{ip}]:8080' if ':' in ip else f'http://{ip}:8080'
   assert sysquery(url)=='external';assert query(worker,url)=='external'
  assert sysquery(f'http://{info["IPAddress"]}:8080')==worker
  assert sysquery(f'http://[{info["GlobalIPv6Address"]}]:8080')==worker
  result=inner('exec',worker,'bun','-e','console.log(await(await fetch("http://parent",{unix:"/run/atelier-parent/parent.sock"})).text())').stdout.decode().strip()
  assert result=='parent-socket'
  assert drops()>start,'denials must hit Atelier rules, not merely Docker bridge isolation'
 checks(a,ai,bi);checks(b,bi,ai)
 c,ci=create_worker(3);checks(c,ci,ai);assert policy()==before
 print('PASS IPv4/IPv6 public egress, DNS/NAT, gateway replies, Unix sockets; private/tailnet allowed; System/peer blocked; third bridge automatically isolated',flush=True)
 # A daemon failure causes supervised System restart; rules reinstall before children start.
 started=json.loads(docker('inspect',name).stdout)[0]['State']['StartedAt']
 system('bun','-e','for(const p of new Bun.Glob("/proc/[0-9]*/comm").scanSync()){if((await Bun.file(p).text()).trim()==="dockerd")process.kill(Number(p.split("/")[2]),"SIGTERM")}',check=False)
 until(lambda:json.loads(docker('inspect',name).stdout)[0]['State']['StartedAt']!=started)
 until(lambda:inner('info',check=False).returncode==0)
 until(lambda:json.loads(sysquery('http://127.0.0.1:3001/status'))['healthy'])
 setup_routes_and_socket()
 for worker in workers:inner('start',worker)
 checks(c,ci,ai);assert policy()==before
 print('PASS daemon/System restart restores static policy and leaves Docker rules intact',flush=True)
finally:
 docker('rm','-f',name,endpoint,check=False);docker('volume','rm',name,check=False);docker('network','rm',uplink,check=False)
