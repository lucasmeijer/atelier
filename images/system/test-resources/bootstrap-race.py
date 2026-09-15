#!/usr/bin/env python3
"""Linux host: bootstrap-race.py SYSTEM_IMAGE RESOURCES_TS; races docker exec against initialization."""
import subprocess,concurrent.futures,sys
image,source=sys.argv[1:];name='atelier-resource-race'
def docker(*args):return subprocess.run(['docker',*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert docker('run','-d','--name',name,'--privileged','--cgroupns=host','--memory=3g','--tmpfs','/run','--entrypoint','sleep',image,'60').returncode==0
try:
    assert docker('cp',source,name+':/tmp/resources.ts').returncode==0
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        futures=[pool.submit(docker,'exec',name,'sleep','0.2') for _ in range(30)]
        result=docker('exec',name,'bun','-e','import {initializeResources} from "/tmp/resources.ts"; console.log(await initializeResources())')
        print(result.stdout.decode(),result.stderr.decode());assert result.returncode==0
    print('PASS concurrent docker exec during cgroup initialization')
finally:docker('rm','-f',name)
