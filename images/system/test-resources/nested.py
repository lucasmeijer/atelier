#!/usr/bin/env python3
"""Verify a real workspace's nested Docker build remains in System workloads.
Run on the Linux Docker host: nested.py SYSTEM WORKSPACE BASE_IMAGE STRESS_BINARY.
BASE_IMAGE must already exist in System's Docker store; STRESS_BINARY is stress.go
compiled for the workspace architecture. The workspace must have Docker running.
"""
import json,pathlib,subprocess,sys,time
system,workspace,base,binary=sys.argv[1:]
def outer(*args):return ['docker','exec','-i',system,'docker',*args]
def inner(*args):return outer('exec',workspace,'docker',*args)
def execute(args,**kwargs):return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs).stdout
config=json.loads(execute(['docker','exec',system,'cat','/run/atelier-system/resources.json']))
root=pathlib.Path('/sys/fs/cgroup'+config['workloadsCgroupParent'])
source=subprocess.Popen(outer('save',base),stdout=subprocess.PIPE)
execute(outer('exec','-i',workspace,'docker','load'),stdin=source.stdout)
assert source.wait()==0
execute(outer('exec',workspace,'mkdir','-p','/tmp/atelier-resource-probe'))
execute(outer('exec','-i',workspace,'tee','/tmp/atelier-resource-probe/stress'),input=pathlib.Path(binary).read_bytes())
execute(outer('exec',workspace,'chmod','+x','/tmp/atelier-resource-probe/stress'))
execute(outer('exec','-i',workspace,'tee','/tmp/atelier-resource-probe/Dockerfile'),input=f'FROM {base}\nCOPY stress /stress\nRUN /stress probe\n'.encode())
with open('/tmp/atelier-nested-resource-build.log','wb') as log:
    build=subprocess.Popen(inner('build','--no-cache','-t','atelier-resource-probe','/tmp/atelier-resource-probe'),stdout=log,stderr=log)
    found=None
    try:
        for attempt in range(150):
            for path in root.rglob('cgroup.procs'):
                for pid in path.read_text().split():
                    try:
                        args=pathlib.Path('/proc',pid,'cmdline').read_bytes().split(bytes([0]))
                        if b'/stress' in args and b'probe' in args:found=path
                    except FileNotFoundError:pass
            if found:break
            if build.poll() is not None:break
            time.sleep(.2)
        assert found,'build RUN was not found below workload group'
        print('Nested build RUN membership:',found)
        assert build.wait(timeout=60)==0
    finally:
        if build.poll() is None:build.terminate();build.wait()
execute(inner('image','rm','atelier-resource-probe'))
execute(outer('exec',workspace,'rm','-rf','/tmp/atelier-resource-probe'))
print('PASS nested Docker build containment')
