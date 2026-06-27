# Atelier workspace image

Workspace containers are assembled from module contributions instead of one hand-written Dockerfile.

Atelier package modules contribute `workspace-image.json` files at their package roots. These compose the default Atelier workspace image:

```txt
packages/workspace-image/workspace-image.json
packages/workspace-terminal/workspace-image.json
packages/vscode/workspace-image.json
```

A checked-out repository can extend that default image with `.atelier/workspace.json`. The manifest can add Ubuntu packages, files/directories to copy into the image, build-time `RUN` scripts, default environment variables, and runtime options:

```json
{
  "version": 1,
  "aptPackages": ["libpq-dev", "postgresql-client"],
  "env": { "EXAMPLE": "value" },
  "run": ["corepack enable"],
  "files": [{ "from": ".atelier/image/rootfs/etc/example.conf", "to": "/etc/example.conf", "mode": "0644" }],
  "initScripts": ["echo runtime startup step"],
  "privileged": false
}
```

Repo `files[].from` paths are relative to the repository root and may not escape it.

## Default image

The default workspace image is built from Atelier's package `workspace-image.json` files. In local development, `bun run web` writes a temporary Docker build context under `/tmp`, ensures the deterministic local image tag exists before starting the dev server, and only builds when that image tag is missing from Docker.

When publishing Atelier with `bun run image:publish`, the publish script also builds and pushes the corresponding default workspace image to:

```txt
ghcr.io/lucasmeijer/atelier-workspace:<hash>
```

The Atelier app image is built with that exact default workspace image reference baked into `/app/.atelier-default-workspace-image`.

## Repository extensions

If a workspace repo has `.atelier/workspace.json`, Atelier builds a local derived image on demand:

```Dockerfile
FROM ghcr.io/lucasmeijer/atelier-workspace:<hash>
# repo additions from .atelier/workspace.json
```

If the repo has no `.atelier/workspace.json`, workspace creation pulls/uses the baked default workspace image directly and does not build a workspace image.
