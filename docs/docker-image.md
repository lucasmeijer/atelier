# Atelier Docker image

Build the Atelier app and its matching default workspace image:

```sh
bun run image:build
```

By default the script builds `ghcr.io/lucasmeijer/atelier:<git-description>` and `ghcr.io/lucasmeijer/atelier:latest` from `apps/web/Dockerfile` and embeds the current git commit metadata in `ATELIER_COMMIT_ID` and `ATELIER_COMMIT_DESCRIPTION`. The default workspace image uses a deterministic content tag, so the build reuses it when that tag already exists locally (or in the registry during `image:publish`). Pass `--workspace` to force rebuilding that image.

Useful options:

```sh
bun run image:build -- --image ghcr.io/example/atelier --tag v0.1.0 --latest
bun run image:build -- --tag dev --workspace --progress plain
bun run image:build -- --tag dev --no-cache --progress plain
bun run image:publish -- --image ghcr.io/example/atelier --tag v0.1.0
bun run scripts/build-atelier-image.ts --push --image ghcr.io/example/atelier --tag v0.1.0 --platform linux/amd64
```

`image:publish` is the same build pipeline with `--push` enabled and defaults to `--platform linux/amd64,linux/arm64` for both the app and workspace images. The local Docker Buildx builder must support both platforms (native build nodes or QEMU emulation). Pass `--platform linux/amd64` to explicitly publish only one architecture. Publishing with `--stable` updates the installer’s default channel; changing the build command alone does not update existing registry tags.

The installer reads the default workspace image reference embedded in the app
image and pulls that exact image for the Docker host architecture. In shared
installations, tagged/local nested-Docker preloads are published to the shared
registry and pulled through Tailscale Serve; ordinary upstream pulls are unchanged.

## Deploy an unmerged branch normally

Do not use `bun run release` for this: that command deliberately releases
`origin/main`. From a clean checkout of the desired branch, use the normal image
pipeline with channel promotion disabled:

```sh
git switch docker-rewrite
git pull --ff-only
bun run check
bun run image:publish -- --tag docker-rewrite --tag "sha-$(git rev-parse HEAD)" --no-latest --progress plain
```

This builds/publishes **both complete images**, for amd64 and arm64, and bakes the
matching content-addressed workspace tag into the app. No runtime-file overlays,
source mounts, dev server or manually patched workspace are needed. In an Atelier
workspace, run `bun run release --check` first to prepare/check the FUSE Buildx
builder, then pass the printed builder name with `--builder <name>` to the image
command. This check publishes nothing and does not change the current branch.

On the deployment host, use this branch's installer with the exact commit image:

```sh
curl -fsSL https://raw.githubusercontent.com/lucasmeijer/atelier/docker-rewrite/scripts/install.sh -o /root/install-atelier.sh
sudo bash /root/install-atelier.sh --image ghcr.io/lucasmeijer/atelier:sha-<full-commit-sha>
```

The installer replaces its existing `atelier` container and configures Tailscale
Serve. Do not run it alongside another independently started Atelier using the
same application/egress ports. Preserve any existing installation data before
changing which installation is running. New workspaces use the baked image;
existing containers are not silently converted.

Use disk-backed storage with enough free capacity for both compressed downloads
and extracted images. The normal data path is `/var/lib/atelier`; the owned runtime
rejects `tmpfs`/`ramfs` backing even when it is bind-mounted. A full `/tmp` or a host
with only a few GB free is not a suitable deployment target. This validation is
not cache eviction or a disk quota: shared layers can still grow indefinitely.

## Production resource isolation

The Linux installer requires cgroup v2, systemd, Docker's systemd cgroup driver, at least 3 GiB of memory, and at least two logical CPUs. It rejects cgroup v1 before configuring Atelier. It creates `atelier-workspaces.slice` and places every workspace container beneath that slice. The slice applies aggregate limits across all workspaces: it leaves 2 GiB of host memory and one logical CPU outside workspace use, disables workspace swap, limits the pool to 32,768 tasks, and gives workspace CPU and I/O lower scheduling weight. These are pool limits rather than per-workspace limits, so idle workspaces do not strand capacity and active workspaces share what is available.

The Atelier server receives a 1 GiB memory reservation, increased CPU weight, and a reduced OOM score. Its workspace-slice label and server resource settings survive self-update. The hard aggregate memory and CPU limits are what keep runaway workspace workloads from consuming the capacity reserved for Atelier and the host; the scheduling weights improve responsiveness during contention.

These guarantees are installed by `scripts/install.sh`. Ad-hoc `docker run` launches do not create host cgroups and therefore do not provide the production resource guarantees.

The resulting container expects access to Docker so it can create Atelier workspace containers. Its entrypoint starts as root, grants the fixed container user `1000:1000` access to the mounted Docker socket, prepares the Atelier data directory, and then runs Atelier as that fixed user. Docker-run workspace containers use the same numeric uid/gid and the `default` namespace. Workspace app ports are published on the Docker host loopback. The Atelier container must run with host networking on Linux so Atelier and host-run Atelier both reach workspace apps at `127.0.0.1:<published-port>`. See [workspace networking](./workspace-networking.md) for the reasoning and experiments behind this model.

For production and branch evaluation, use the installer above. It supplies the
persistent same-path runtime mount, `--privileged`, the Tailscale LocalAPI socket,
`--own-snapshotter`, and host resource controls. A bare `docker run` without these
is not equivalent to an installed Atelier.

On hosts without cgroup swap controls, installation is allowed only when `/proc/meminfo` reports zero total swap. Keep swap disabled on these hosts; hosts with swap require working cgroup swap limits. The installer explicitly pulls images for the Docker server’s platform, so a release missing that platform fails at pull time rather than with an `exec format error`.
