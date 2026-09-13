#!/bin/bash
set -euo pipefail

# Derived images can invoke atelier-dockerd from their own supervisor, or replace
# /etc/{docker/daemon.json,containerd/config.toml}. No runtime configuration env vars.
if [[ "$1" != dockerd ]]; then
    exec "$@"
fi
shift

containerd --config /etc/containerd/config.toml &
containerd_pid=$!
dockerd_pid=
shutdown() {
    trap - EXIT TERM INT
    if [[ -n "$dockerd_pid" ]] && kill -0 "$dockerd_pid" 2>/dev/null; then
        kill -TERM "$dockerd_pid"
        wait "$dockerd_pid" || true
    fi
    if kill -0 "$containerd_pid" 2>/dev/null; then
        kill -TERM "$containerd_pid"
        wait "$containerd_pid" || true
    fi
}
trap shutdown EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# A socket can exist before containerd is ready (or survive a crashed process).
for ((attempt = 0; attempt < 100; attempt++)); do
    if ctr version >/dev/null 2>&1; then
        break
    fi
    kill -0 "$containerd_pid"
    sleep 0.1
done
ctr version >/dev/null

dockerd --config-file /etc/docker/daemon.json "$@" &
dockerd_pid=$!
# A daemon exiting brings down its sibling; errors remain visible to the caller.
wait -n "$containerd_pid" "$dockerd_pid"
