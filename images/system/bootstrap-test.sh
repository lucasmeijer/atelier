#!/bin/bash
# Exercise a first supervisor boot against a disposable local registry, including
# the eagerly-preload label. Requires built System and atelier-test:v1 images.
set -euo pipefail
system_image="${1:-atelier-system:big-rewrite}"
name="atelier-bootstrap-test-$$"
volume="$name"
cleanup() {
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker pull registry:2 >/dev/null
docker run -d --privileged --cgroupns=host --tmpfs /run --name "$name" --mount "source=$volume,target=/data" \
    --entrypoint /usr/local/bin/atelier-dockerd "$system_image" dockerd >/dev/null
for ((i=0;i<120;i++)); do
    if docker exec "$name" docker info >/dev/null 2>&1; then break; fi
    sleep 0.25
done
docker exec "$name" docker info >/dev/null
docker save registry:2 atelier-test:v1 | docker exec -i "$name" docker load >/dev/null
docker exec "$name" docker run -d --name registry --restart always \
    -p 127.0.0.1:5000:5000 --mount source=registry,target=/var/lib/registry registry:2 >/dev/null
docker exec "$name" docker tag atelier-test:v1 localhost:5000/test-base:latest
docker exec "$name" docker push localhost:5000/test-base:latest >/dev/null
printf '%s\n' 'FROM atelier-test:v1' 'LABEL eagerly-preload="[\"localhost:5000/test-base:latest\"]"' \
    | docker exec -i "$name" docker build -t localhost:5000/test-app:v1 - >/dev/null
docker exec "$name" docker push localhost:5000/test-app:v1 >/dev/null
docker exec "$name" docker image rm localhost:5000/test-app:v1 localhost:5000/test-base:latest >/dev/null
# The preparer ran only daemons: no supervisor selection/state exists yet.
docker stop --timeout 60 "$name" >/dev/null
docker rm "$name" >/dev/null
docker run -d --privileged --cgroupns=host --tmpfs /run --name "$name" --mount "source=$volume,target=/data" \
    "$system_image" --app-image localhost:5000/test-app:v1 >/dev/null
for ((i=0;i<120;i++)); do
    if docker exec "$name" bun -e 'const s=await(await fetch("http://127.0.0.1:3001/status")).json();process.exit(s.healthy?0:1)' >/dev/null 2>&1; then break; fi
    sleep 1
done
docker exec "$name" bun -e 'const s=await(await fetch("http://127.0.0.1:3001/status")).json();if(!s.healthy)throw new Error(JSON.stringify(s));'
docker exec "$name" docker image inspect localhost:5000/test-app:v1 localhost:5000/test-base:latest >/dev/null
docker exec "$name" bun -e 'const s=await(await fetch("http://127.0.0.1:3000/state")).json();if(s.version!=="v1")throw new Error(JSON.stringify(s));'
printf 'PASS: first supervisor boot pulls app and eagerly-preload dependency, then starts a healthy app\n'
