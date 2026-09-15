#!/bin/bash
set -euo pipefail
# Publish an immutable System image; promote to latest after release validation.
cd "$(dirname "$0")/../.."
if [[ -n $(git status --porcelain) ]]; then
  echo 'Commit changes before publishing System.' >&2
  exit 1
fi
revision=$(git rev-parse HEAD)
image="ghcr.io/lucasmeijer/atelier-system:sha-${revision}"
bun install --cwd images/system --frozen-lockfile
bun images/system/build.ts
docker buildx build --platform linux/arm64,linux/amd64 --push \
  --tag "$image" --label "org.opencontainers.image.revision=${revision}" \
  --file images/system/Dockerfile "$@" images/system
docker buildx imagetools inspect "$image"
