#!/bin/sh
set -eu

nested=0
case "${1:-}" in
  --nested)
    nested=1
    shift
    if [ ! -r /.atelier/docker-runtime.json ]; then
      echo "error: --nested requires an inherited runtime connection at /.atelier/docker-runtime.json" >&2
      exit 1
    fi
    ;;
  --*)
    echo "error: unknown Atelier entrypoint option: $1 (expected --nested or an application command)" >&2
    exit 1
    ;;
esac
if [ "$#" -eq 0 ]; then set -- bun run apps/web/src/server/main.ts; fi
if [ "$nested" -eq 0 ]; then
  runtime="${ATELIER_DOCKER_HOST_DATA_DIR:?standalone Atelier requires Docker-host data path and a persistent runtime bind}/docker-runtime"
fi

atelier_uid=1000
atelier_gid=1000

if ! getent group "$atelier_gid" >/dev/null; then
  groupadd --gid "$atelier_gid" atelier
fi
if ! getent passwd "$atelier_uid" >/dev/null; then
  useradd --uid "$atelier_uid" --gid "$atelier_gid" --create-home --shell /bin/bash atelier
fi
atelier_user="$(getent passwd "$atelier_uid" | cut -d: -f1)"

if [ -S /var/run/docker.sock ]; then
  docker_gid="$(stat -c '%g' /var/run/docker.sock)"
  if ! getent group "$docker_gid" >/dev/null; then
    groupadd --gid "$docker_gid" docker-host
  fi
  docker_group="$(getent group "$docker_gid" | cut -d: -f1)"
  usermod -aG "$docker_group" "$atelier_user"
fi

atelier_data_dir="${ATELIER_DATA_DIR:-/data/atelier}"
mkdir -p "$atelier_data_dir/proxy"
# The root registry publisher and app share the existing Serve configuration lock.
chown "$atelier_uid:$atelier_gid" "$atelier_data_dir/proxy"

printf '%s ALL=(root) NOPASSWD: /usr/local/bin/atelier-tailscale-serve-helper\n' "$atelier_user" >/etc/sudoers.d/atelier-tailscale-serve
chmod 440 /etc/sudoers.d/atelier-tailscale-serve

HOME="$(getent passwd "$atelier_uid" | cut -d: -f6)"
export HOME
if [ "$nested" -eq 0 ]; then
  exec /usr/local/bin/atelier-owned-snapshotter "$runtime" "$atelier_gid" gosu "$atelier_user" "$@"
fi
exec gosu "$atelier_user" "$@"
