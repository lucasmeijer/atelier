#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
bun install --cwd images/system --frozen-lockfile
bun images/system/build.ts
for fixture in v1:healthy v2:slow broken:broken retry:retry; do
    docker build -f images/system/test-app/Dockerfile \
        --build-arg VERSION="${fixture%:*}" --build-arg MODE="${fixture#*:}" \
        -t "atelier-test:${fixture%:*}" images/system
done
