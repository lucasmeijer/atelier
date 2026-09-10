# Atelier workspace image

Workspace containers are assembled in two layers:

1. Atelier modules contribute `workspace-image.json` files at their package roots. These compose the default Atelier workspace image.
2. A repository can optionally add `.atelier/Dockerfile` to build its final workspace image on top of that default image.

Module manifests are internal to Atelier packages, for example:

```txt
packages/workspace-image/workspace-image.json
packages/workspace-terminal/workspace-image.json
packages/vscode/workspace-image.json
```

## Default image

The default workspace image is built from Atelier's package `workspace-image.json` files. It includes Docker CLI/daemon packages, Compose, Buildx, and `fuse-overlayfs`. Every workspace starts its own private nested Docker daemon automatically, without repository configuration. Without a shared runtime, the daemon uses `fuse-overlayfs` so inner image builds do not depend on kernel OverlayFS mounts inside the outer container's filesystem. Owned Linux installations use the shared-runtime startup described below. It stops with the workspace container and starts again when the workspace resumes. Image preloading is an optional optimization, independent of daemon startup.

In local development, `bun run web` writes a temporary Docker build context under `/tmp`, ensures the deterministic local image tag exists before starting the dev server, and only builds when that image tag is missing from Docker (unless the existing explicit no-cache setting is enabled). This also applies to shared runtimes: a preloaded default is reused by both the dev launcher and its server without another build, publication or pull. Repository Dockerfiles still re-solve their current context. After Atelier builds a default, repository, or carrier image, it starts a non-blocking Docker prune for older unused Atelier images of the same kind. Images created after that build began are excluded, and Docker retains images referenced by containers.

When publishing Atelier with `bun run image:publish`, the publish script also builds and pushes the corresponding default workspace image to:

```txt
ghcr.io/lucasmeijer/atelier-workspace:<hash>
```

The Atelier app image is built with that exact default workspace image reference baked into `/app/.atelier-default-workspace-image`.

## Shared-runtime workspace startup

In an installation with a shared Docker connection, new workspaces automatically
register a private runtime and use the supervised local snapshotter/containerd/
Docker startup command in the default image. The default image compiles
`atelier-snapshotter` in a separate Go build stage; its source is part of the
image's content identity. The local listener starts before containerd without
waiting for its callback socket. Containerd's snapshot proxy points locally;
content and diff proxies still point to the installation's client socket. Docker becomes ready before workspace startup continues. A
missing or invalid declared runtime fails visibly; it does not fall back to FUSE.
Installations without a shared connection retain the original startup path.

Each workspace receives a fresh client identity and passes the same installation
connection to nested Atelier processes. Atelier running from source inside a
workspace inherits that connection instead of starting a second adapter. Nesting uses distinct network ranges, with a current limit of 11
private-runtime levels.

Parking preserves the registration and private Docker state. Deletion removes the
container before retiring its client. Failed provisioning also retires the client;
if cleanup fails, its ownership record is retained for a later forced deletion
rather than discarded. Existing workspace stores are not converted.

Shared-registry preloads publish the selected tagged or local images before
workspace startup, then pull their exact registry digests through the inherited
socket and install the requested aliases. Locally built, unpublished images work;
moving a source tag after selection does not change the preloaded image. These
pulls finish before user initialization scripts run. No carrier image is generated.

Explicit upstream `repository@digest` references retain their original pull path
and identity: republishing a platform-filtered index can change its digest. Such
references must remain reachable with the workspace's upstream credentials.

When the runtime generates a default image, it now uses the same shared builder
and registry as repository images, while retaining the generated default tag and
aliases. Already-baked default image references are still pulled normally. The
standalone `image:build` / `image:publish` release pipeline remains unchanged.
No new environment variable is required.

Shared installations build repository Dockerfiles with their shared BuildKit worker
and publish/pull the result by digest. The current build context is always solved,
so changing COPY inputs cannot be hidden by an existing image tag. Both the context
`.dockerignore` and Dockerfile-specific ignore files are respected. The selected
`atelier-workspace` base is published once from the creator's Docker store; local
image names are not assumed to exist in the standalone builder. Native nested
creators need the `buildctl` client included in new default workspace images.

## Repository Dockerfile

If a workspace repo has `.atelier/Dockerfile`, Atelier builds a local derived image on demand. The Dockerfile must start with:

```Dockerfile
FROM atelier-workspace
```

Before building the repository Dockerfile, Atelier tags the resolved default workspace image as the local Docker image `atelier-workspace`. The repository Dockerfile can then use normal Dockerfile features:

```Dockerfile
FROM atelier-workspace
# Atelier image version: 1

RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq-dev postgresql-client

ENV EXAMPLE=value
COPY .atelier/image/example.conf /etc/example.conf
RUN chmod 0644 /etc/example.conf
```

Atelier automatically adds BuildKit apt cache mounts to simple repository Dockerfile instructions that start with `RUN apt-get update`, so users can keep these Dockerfiles readable without writing cache mount boilerplate.

Repository image reuse is based on the default workspace image plus `.atelier/Dockerfile` contents only, not the full repository contents. Normal source changes therefore do not rebuild the workspace image. If the Dockerfile depends on another repository file through `COPY` or `ADD`, bump a version comment in `.atelier/Dockerfile` when that file changes.

If the repo has no `.atelier/Dockerfile`, workspace creation pulls/uses the baked default workspace image directly and does not build a repository image.

## Preloaded nested-Docker images

Repositories can request images for their private Docker daemon:

```json
{
  "version": 1,
  "docker": {
    "privileged": true,
    "preloadImages": ["default-atelier-workspace-image", "ubuntu:24.04", "postgres:18"]
  }
}
```

Values are exact Docker references. `default-atelier-workspace-image` is reserved and resolves to the exact default image selected by the outer Atelier process; Atelier also installs its deterministic `atelier-workspace:<hash>` alias. Invalid or unavailable references fail provisioning; shared-registry mode also accepts images already built in the creator's Docker store. Duplicate declarations are deduplicated internally.

Without a shared runtime, on a native Linux Docker Engine, Atelier builds or reuses a deterministic **carrier image on demand** the first time a matching workspace is created: the normal workspace image plus a cleanly stopped, `fuse-overlayfs`-backed `/var/lib/docker`. Every carrier is execution-tested after commit. Each workspace receives an independent writable container layer; Atelier never shares a mutable daemon store between workspaces. Carrier identity includes the outer base, platform, format version, refs, aliases, and resolved image IDs, so mutable tags and incompatible workspace versions produce cache misses rather than incorrect reuse.

Docker Desktop and non-Linux Docker Engines are explicitly excluded even when Atelier itself runs in a Linux container. On those platforms `docker.preloadImages` does nothing: Atelier does not resolve or pull the requested nested images, mount an archive, or run `docker load`. Carrier-backed preloading is a native-Linux-only feature. The normal private daemon still starts on Docker Desktop, with an initially empty image store. Some LinuxKit kernels reject `security.capability` reads on FUSE executables, causing inner containers to fail with `exec ...: invalid argument`; the build/run integration test therefore runs on native Linux. Daemon startup and Compose installation are tested on both platforms.

Project settings can also store a custom workspace Dockerfile. This override takes priority over `.atelier/Dockerfile`, without changing the repository file. Clear the setting to restore repository/default behavior. Both sources must start with `FROM atelier-workspace` and use the workspace repository as build context. Changes affect newly created workspaces, not existing containers (workspace copies retain their source image). Image reuse includes the selected Dockerfile contents.
