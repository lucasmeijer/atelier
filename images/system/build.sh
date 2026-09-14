#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
bun install --cwd images/system --frozen-lockfile
bun images/system/build.ts
docker build -f images/system/Dockerfile "$@" images/system
