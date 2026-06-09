#!/usr/bin/env bash
set -euo pipefail

IMAGE="${ATELIER_WEB_IMAGE:-atelier-web:local}"
CONTAINER="${ATELIER_WEB_CONTAINER:-atelier-web}"
PORT="${PORT:-3000}"
HOST_DATA_DIR="${ATELIER_HOST_DATA_DIR:-${HOME}/Library/Application Support/atelier}"
CONTAINER_DATA_DIR="${ATELIER_CONTAINER_DATA_DIR:-${HOST_DATA_DIR}}"
WORKSPACE_IMAGE="${ATELIER_WORKSPACE_IMAGE:-ghcr.io/lucasmeijer/atelier-workspace:latest}"
NAMESPACE="${ATELIER_NAMESPACE:-default}"
AGENT_FAKE="${ATELIER_AGENT_FAKE:-0}"

case "${1:-}" in
  build)
    docker build -f apps/web/Dockerfile -t "${IMAGE}" .
    ;;
  run)
    mkdir -p "${HOST_DATA_DIR}"
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
    docker run -d \
      --name "${CONTAINER}" \
      -p "${PORT}:3000" \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "${HOST_DATA_DIR}:${CONTAINER_DATA_DIR}" \
      -e HOST=0.0.0.0 \
      -e PORT=3000 \
      -e ATELIER_DATA_DIR="${CONTAINER_DATA_DIR}" \
      -e ATELIER_NAMESPACE="${NAMESPACE}" \
      -e ATELIER_WORKSPACE_IMAGE="${WORKSPACE_IMAGE}" \
      -e ATELIER_AGENT_FAKE="${AGENT_FAKE}" \
      "${IMAGE}"
    ;;
  stop)
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
    ;;
  logs)
    docker logs -f "${CONTAINER}"
    ;;
  shell)
    docker exec -it "${CONTAINER}" bash
    ;;
  *)
    cat <<USAGE
Usage: $0 build|run|stop|logs|shell

Defaults:
  ATELIER_WEB_IMAGE=${IMAGE}
  ATELIER_WEB_CONTAINER=${CONTAINER}
  ATELIER_HOST_DATA_DIR=${HOST_DATA_DIR}
  ATELIER_CONTAINER_DATA_DIR=${CONTAINER_DATA_DIR}
  ATELIER_WORKSPACE_IMAGE=${WORKSPACE_IMAGE}
  ATELIER_NAMESPACE=${NAMESPACE}
  ATELIER_AGENT_FAKE=${AGENT_FAKE}
  PORT=${PORT}
USAGE
    exit 64
    ;;
esac
