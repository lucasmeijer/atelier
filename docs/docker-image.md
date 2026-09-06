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
bun run scripts/build-atelier-image.ts --push --image ghcr.io/example/atelier --tag v0.1.0 --platform linux/amd64
```

`image:publish` is the same build pipeline with `--push` enabled and defaults to `--platform linux/amd64,linux/arm64` for both the app and workspace images. The local Docker Buildx builder must support both platforms (native build nodes or QEMU emulation). Pass `--platform linux/amd64` to explicitly publish only one architecture. Publishing with `--stable` updates the installer’s default channel; changing the build command alone does not update existing registry tags.

The installer pulls the required default workspace image. Repositories that request nested-Docker image preloads get deterministic carrier images built on demand when their first matching workspace is created. Carriers embed a `fuse-overlayfs` nested Docker store and are selected only on native Linux, never Docker Desktop.

## Production resource isolation

The Linux installer requires cgroup v2, systemd, Docker's systemd cgroup driver, at least 3 GiB of memory, and at least two logical CPUs. It rejects cgroup v1 before configuring Atelier. It creates `atelier-workspaces.slice` and places every workspace container beneath that slice. The slice applies aggregate limits across all workspaces: it leaves 2 GiB of host memory and one logical CPU outside workspace use, disables workspace swap, limits the pool to 32,768 tasks, and gives workspace CPU and I/O lower scheduling weight. These are pool limits rather than per-workspace limits, so idle workspaces do not strand capacity and active workspaces share what is available.

The Atelier server receives a 1 GiB memory reservation, increased CPU weight, and a reduced OOM score. Its workspace-slice label and server resource settings survive self-update. The hard aggregate memory and CPU limits are what keep runaway workspace workloads from consuming the capacity reserved for Atelier and the host; the scheduling weights improve responsiveness during contention.

These guarantees are installed by `scripts/install.sh`. Ad-hoc `docker run` and `bun run docker:dev` launches do not create host cgroups and therefore do not provide the production resource guarantees.

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

On hosts without cgroup swap controls, installation is allowed only when `/proc/meminfo` reports zero total swap. Keep swap disabled on these hosts; hosts with swap require working cgroup swap limits. The installer explicitly pulls images for the Docker server’s platform, so a release missing that platform fails at pull time rather than with an `exec format error`.
