#!/bin/sh
set -eu

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
mkdir -p "$atelier_data_dir"

export HOME="$(getent passwd "$atelier_uid" | cut -d: -f6)"
exec gosu "$atelier_user" "$@"
