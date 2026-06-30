# Atelier Docker image

Build and restart a local development Atelier container from the repository root:

```sh
bun run docker:dev
```

On Linux this stops any existing Atelier server container, builds `atelier:latest`, and starts an attached host-networked container named `atelier` on <http://127.0.0.1:3000>. Press Ctrl-C to stop and remove the container. Docker-run Atelier uses the default namespace/data path; host-run Atelier is isolated under the `host` namespace and `atelier-host` data path.

Build only a local Atelier runtime image:

```sh
bun run image:build
```

By default the script builds `atelier:<git-description>` and `atelier:latest` from `apps/web/Dockerfile` and embeds the current git commit metadata in `ATELIER_COMMIT_ID` and `ATELIER_COMMIT_DESCRIPTION`. The default workspace image uses a deterministic content tag, so the build reuses it when that tag already exists locally (or in the registry during `image:publish`). Pass `--workspace` to force rebuilding that image.

Useful options:

```sh
bun run docker:dev -- --bind 127.0.0.1 --port 3000
bun run docker:dev -- --bind "$(tailscale ip -4)" --port 80
bun run docker:dev -- --detach
bun run image:build -- --image ghcr.io/example/atelier --tag v0.1.0 --latest
bun run image:build -- --tag dev --workspace --progress plain
bun run image:build -- --tag dev --no-cache --progress plain
bun run image:publish -- --image ghcr.io/example/atelier --tag v0.1.0
bun run scripts/build-atelier-image.ts --push --image ghcr.io/example/atelier --tag v0.1.0 --platform linux/amd64,linux/arm64
bun run scripts/build-atelier-image.ts --push --image ghcr.io/example/atelier --tag v0.1.0 --platform linux/amd64 --builder-host root@agent-test
```

`image:publish` is the same build pipeline with `--push` enabled and defaults to `--platform linux/amd64 --builder-host root@agent-test`. The build script creates a buildx docker-container builder for `ssh://root@agent-test` when needed. Multi-platform builds require `--push`.

The resulting container expects access to Docker so it can create Atelier workspace containers. Its entrypoint starts as root, grants the fixed container user `1000:1000` access to the mounted Docker socket, prepares the Atelier data directory, and then runs Atelier as that fixed user. Docker-run workspace containers use the same numeric uid/gid and the `default` namespace. Workspace app ports are published on the Docker host loopback. The Atelier container must run with host networking on Linux so Atelier and host-run Atelier both reach workspace apps at `127.0.0.1:<published-port>`. See [workspace networking](./workspace-networking.md) for the reasoning and experiments behind this model.

A typical local run mounts the host Docker socket and bind-mounts a host data directory. `ATELIER_DOCKER_HOST_DATA_DIR` must be the host path for that same data directory so workspace containers can mount files created by the Atelier container:

```sh
ATELIER_HOST_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/atelier"
mkdir -p "$ATELIER_HOST_DATA_DIR"

docker run --rm -it --init \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --mount "type=bind,src=$ATELIER_HOST_DATA_DIR,dst=/data/atelier" \
  -e ATELIER_DATA_DIR=/data/atelier \
  -e ATELIER_DOCKER_HOST_DATA_DIR="$ATELIER_HOST_DATA_DIR" \
  atelier:latest
```
