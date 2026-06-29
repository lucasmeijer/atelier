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

The default workspace image is built from Atelier's package `workspace-image.json` files. In local development, `bun run web` writes a temporary Docker build context under `/tmp`, ensures the deterministic local image tag exists before starting the dev server, and only builds when that image tag is missing from Docker.

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

RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq-dev postgresql-client \
 && rm -rf /var/lib/apt/lists/*

ENV EXAMPLE=value
COPY .atelier/image/example.conf /etc/example.conf
RUN chmod 0644 /etc/example.conf
```

If the repo has no `.atelier/Dockerfile`, workspace creation pulls/uses the baked default workspace image directly and does not build a repository image.
