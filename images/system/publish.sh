#!/bin/bash
set -euo pipefail
# Publish an immutable System image; promote to latest after release validation.
cd "$(dirname "$0")/../.."
exec bun images/system/publish.ts "$@"
