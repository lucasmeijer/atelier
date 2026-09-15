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
image and pulls that exact image for the Docker host architecture. Shared
installations reuse retained image layers across private Docker daemons on demand.

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
workspace, set `ATELIER_RELEASE_HELPER=user@hostname` and run
`bun run release --check` first to check the local and SSH helper Docker builders.
For a native split build of this branch, add `--builder <local-context>`,
`--helper-context <helper-context>`, and `--native-platform linux/amd64` (or
`linux/arm64` on an ARM workstation) to the image command above. The check logs
show the selected context names. Without those flags, the lower-level image
command uses a single builder. The check publishes nothing and does not change
the current branch.

On the deployment host, pin both the installer and image to the same released
commit. Do not use `https://lucasmeijer.com/get-atelier` for this branch test: that
website endpoint serves the installer published from `main`, not this branch.

```sh
commit='<full-commit-sha>'
curl -fsSL "https://raw.githubusercontent.com/lucasmeijer/atelier/$commit/scripts/install.sh" -o /root/install-atelier.sh
sudo bash /root/install-atelier.sh --image "ghcr.io/lucasmeijer/atelier:sha-$commit"
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

Atelier System owns sibling cgroup v2 groups for management and collective workloads. It requires the CPU, memory, process and I/O controllers, at least 3 GiB of effective memory and an effective process limit of at least 2,048. System uses the host cgroup namespace to account for ancestor limits, while workspace containers retain private cgroup namespaces.

Workspaces, their descendants, Docker build RUN steps and cache conversion commands share the workload group. Management has CPU weight 1,000 versus workloads' 100; there is no workload CPU quota. Workloads leave management 20% of effective memory, bounded between 1 and 4 GiB, have a soft pressure threshold at 90% of their memory ceiling, and cannot use swap. Their collective process ceiling is the smaller of 8,192 and the effective System ceiling minus 1,024. Management also receives memory.low protection. These limits protect against ordinary exhaustion, not privileged adversarial escape.

I/O weights are configured at the same 10:1 ratio, but their effect depends on the host block scheduler and storage stack. Docker daemon downloads, exports and layer bookkeeping remain management work; only build RUN processes and explicitly launched cache conversion are moved to workloads. Local developer runs without a System resource descriptor use their selected Docker context without these System protections.

The resulting container expects access to Docker so it can create Atelier workspace containers. Its entrypoint starts as root, grants the fixed container user `1000:1000` access to the mounted Docker socket, prepares the Atelier data directory, and then runs Atelier as that fixed user. Docker-run workspace containers use the same numeric uid/gid and the `default` namespace. Workspace app ports are published on the Docker host loopback. The Atelier container must run with host networking on Linux so Atelier and host-run Atelier both reach workspace apps at `127.0.0.1:<published-port>`. See [workspace networking](./workspace-networking.md) for the reasoning and experiments behind this model.

For production and branch evaluation, use the installer above. It supplies the
persistent same-path runtime mount, `--privileged`, the Tailscale LocalAPI socket,
and host resource controls. The image starts the shared snapshotter, registry,
BuildKit and app by default; no ownership flag is needed. A bare `docker run`
without the required mounts and privileges is not equivalent to an installed Atelier.

Nested image launches must explicitly pass `--nested` after the image reference
(and before an optional application command). This mode requires the inherited
`/.atelier/docker-runtime.json` connection and its socket/backing mounts; it runs
the app without starting another shared stack. Merely mounting a connection does
not switch modes. The old `--own-snapshotter` option is no longer accepted.

On hosts without cgroup swap controls, installation is allowed only when `/proc/meminfo` reports zero total swap. Keep swap disabled on these hosts; hosts with swap require working cgroup swap limits. The installer explicitly pulls images for the Docker server’s platform, so a release missing that platform fails at pull time rather than with an `exec format error`.
