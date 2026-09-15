#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then set -- bun run apps/web/src/server/main.ts; fi

atelier_uid=1000
atelier_gid=1000

if ! getent group "$atelier_gid" >/dev/null; then
  groupadd --gid "$atelier_gid" atelier
fi
if ! getent passwd "$atelier_uid" >/dev/null; then
  useradd --uid "$atelier_uid" --gid "$atelier_gid" --create-home --shell /bin/bash atelier
fi
atelier_user="$(getent passwd "$atelier_uid" | cut -d: -f1)"

for socket in /var/run/docker.sock /run/containerd/containerd.sock; do
  [ -S "$socket" ] || continue
  docker_gid="$(stat -c '%g' "$socket")"
  if ! getent group "$docker_gid" >/dev/null; then
    groupadd --gid "$docker_gid" docker-host
  fi
  docker_group="$(getent group "$docker_gid" | cut -d: -f1)"
  usermod -aG "$docker_group" "$atelier_user"
done

atelier_data_dir=/data/app
mkdir -p "$atelier_data_dir/proxy"
# Ensure app state and shared cache can be managed by the app user.
chown "$atelier_uid:$atelier_gid" "$atelier_data_dir" "$atelier_data_dir/proxy" /data/erofs-cache

printf '%s ALL=(root) NOPASSWD: /usr/local/bin/atelier-tailscale-serve-helper\n' "$atelier_user" >/etc/sudoers.d/atelier-tailscale-serve
chmod 440 /etc/sudoers.d/atelier-tailscale-serve

HOME="$(getent passwd "$atelier_uid" | cut -d: -f6)"
export HOME
exec gosu "$atelier_user" "$@"
