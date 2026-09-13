#!/bin/bash
set -euo pipefail
# Authenticate first: gh auth token | docker login ghcr.io -u lucasmeijer --password-stdin
# Publish: images/patched-docker/publish.sh [--builder NAME] [--progress plain]
# Derived images should use the resulting multi-platform digest in FROM.
context=$(cd "$(dirname "$0")" && pwd)
if [[ -n $(git -C "$context" status --porcelain -- .) ]]; then
    echo 'Commit changes in images/patched-docker before publishing.' >&2
    exit 1
fi
revision=$(git -C "$context" rev-parse HEAD)
image="ghcr.io/lucasmeijer/atelier-docker:sha-${revision}"
"$context/build.sh" "$image" --push \
    --label "org.opencontainers.image.revision=${revision}" "$@"
docker buildx imagetools inspect "$image"
