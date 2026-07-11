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

The default workspace image is built from Atelier's package `workspace-image.json` files. It includes Docker CLI/daemon packages and Buildx. Atelier starts a private nested daemon automatically when a repository declares `docker.preloadImages`. In local development, `bun run web` writes a temporary Docker build context under `/tmp`, ensures the deterministic local image tag exists before starting the dev server, and only builds when that image tag is missing from Docker.

When publishing Atelier with `bun run image:publish`, the publish script also builds and pushes the corresponding default workspace image to:

```txt
ghcr.io/lucasmeijer/atelier-workspace:<hash>
```

The Atelier app image is built with that exact default workspace image reference baked into `/app/.atelier-default-workspace-image`.

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

Values are exact Docker references. `default-atelier-workspace-image` is reserved and resolves to the exact default image selected by the outer Atelier process; Atelier also installs its deterministic `atelier-workspace:<hash>` alias. Invalid or unpullable references fail provisioning. Duplicate declarations are deduplicated internally.

On a native Linux Docker Engine, Atelier builds or reuses a deterministic **carrier image on demand** the first time a matching workspace is created: the normal workspace image plus a cleanly stopped, `fuse-overlayfs`-backed `/var/lib/docker`. Every carrier is execution-tested after commit. Each workspace receives an independent writable container layer; Atelier never shares a mutable daemon store between workspaces. Carrier identity includes the outer base, platform, format version, refs, aliases, and resolved image IDs, so mutable tags and incompatible workspace versions produce cache misses rather than incorrect reuse.

Docker Desktop and non-Linux Docker Engines are explicitly excluded even when Atelier itself runs in a Linux container. On those platforms `docker.preloadImages` does nothing: Atelier does not resolve or pull the requested nested images, start a nested daemon, mount an archive, or run `docker load`. Carrier-backed preloading is a native-Linux-only feature.
