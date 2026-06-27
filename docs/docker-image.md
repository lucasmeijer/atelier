# Atelier Docker image

Build and restart a local development Atelier container from the repository root:

```sh
bun run docker:dev
```

This stops any existing Atelier server container, builds `atelier:latest`, and starts an attached container named `atelier` on <http://127.0.0.1:3000>. Press Ctrl-C to stop and remove the container. Docker-run Atelier uses the default namespace/data path; host-run Atelier is isolated under the `host` namespace and `atelier-host` data path.

Build only a local Atelier runtime image:

```sh
bun run image:build -- --latest
```

By default the script builds `atelier:<git-description>` from `apps/web/Dockerfile` and embeds the current git commit metadata in `ATELIER_COMMIT_ID` and `ATELIER_COMMIT_DESCRIPTION`.

Useful options:

```sh
bun run docker:dev -- --bind 127.0.0.1 --port 3000
bun run docker:dev -- --bind "$(tailscale ip -4)" --port 80
bun run docker:dev -- --detach
bun run image:build -- --image ghcr.io/example/atelier --tag v0.1.0 --latest
bun run image:build -- --tag dev --no-cache --progress plain
bun run image:publish -- --image ghcr.io/example/atelier --tag v0.1.0 --platform linux/amd64,linux/arm64
```

`image:publish` is the same build pipeline with `--push` enabled. Multi-platform builds require `--push`.

The resulting container expects access to Docker so it can create Atelier workspace containers. Its entrypoint starts as root, grants the fixed container user `1000:1000` access to the mounted Docker socket, prepares the Atelier data directory, and then runs Atelier as that fixed user. Docker-run workspace containers use the same numeric uid/gid and the `default` namespace. Workspace app ports are published on the Docker host loopback; host-run Atelier connects to `127.0.0.1`, while the Docker image sets `ATELIER_WORKSPACE_CONNECT_HOST=host.docker.internal`.

A typical local run mounts the host Docker socket and bind-mounts a host data directory. `ATELIER_DOCKER_HOST_DATA_DIR` must be the host path for that same data directory so workspace containers can mount files created by the Atelier container:

```sh
ATELIER_HOST_DATA_DIR="$HOME/Library/Application Support/atelier"
mkdir -p "$ATELIER_HOST_DATA_DIR"

docker run --rm -it --init \
  -p 3000:3000 \
  -p 41000-41999:41000-41999 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --add-host host.docker.internal:host-gateway \
  --mount "type=bind,src=$ATELIER_HOST_DATA_DIR,dst=/data/atelier" \
  -e ATELIER_DATA_DIR=/data/atelier \
  -e ATELIER_DOCKER_HOST_DATA_DIR="$ATELIER_HOST_DATA_DIR" \
  atelier:latest
```
