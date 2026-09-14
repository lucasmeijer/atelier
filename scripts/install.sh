#!/usr/bin/env bash
set -euo pipefail

system_image=ghcr.io/lucasmeijer/atelier-system:latest
app_image=ghcr.io/lucasmeijer/atelier:stable
action=""
non_interactive=0
system_name=atelier-system

fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'HELP'
Usage: install.sh [options]

Installs Atelier System, or offers actions for an existing installation.
System replacements preserve the atelier-system volume and interrupt workspaces.

  --system-image REF   System image (default: ghcr.io/lucasmeijer/atelier-system:latest)
  --app-image REF      First-install app image (default: ghcr.io/lucasmeijer/atelier:stable)
  --action ACTION     install, update, connect, or open
  --non-interactive   Install/update without prompts; print login instructions
  -h, --help          Show help

The app image is only used when System has no persisted app selection.
There is no migration from the previous Atelier installation layout.
HELP
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --system-image|--app-image|--action)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"
      case "$1" in
        --system-image) system_image="$2" ;;
        --app-image) app_image="$2" ;;
        --action) action="$2" ;;
      esac
      shift 2 ;;
    --non-interactive) non_interactive=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
case "$action" in ""|install|update|connect|open) ;; *) fail "unknown action: $action" ;; esac
[ "$(uname -s)" = Linux ] || fail "Atelier System requires a Linux host"
[ "$(id -u)" -eq 0 ] || fail "run this installer as root"

if ! command -v docker >/dev/null; then
  printf 'Installing Docker...\n'
  if command -v apt-get >/dev/null; then
    apt-get update
    apt-get install -y docker.io
  elif command -v dnf >/dev/null; then
    dnf install -y docker
  else
    fail "install Docker first; automatic Docker installation supports apt-get and dnf"
  fi
  systemctl enable --now docker
fi
docker info >/dev/null

# Nested daemons share the host kernel; privileged containers cannot supply
# filesystem drivers missing from that kernel.
for filesystem in erofs overlay; do
  if ! grep -qw "$filesystem" /proc/filesystems; then
    if ! command -v modprobe >/dev/null || ! modprobe "$filesystem"; then
      fail "$filesystem is unavailable; install the filesystem modules for $(uname -r), or use a kernel with $filesystem support"
    fi
    grep -qw "$filesystem" /proc/filesystems || fail "$filesystem is still unavailable after modprobe; use a kernel with $filesystem support"
  fi
done
mkdir -p /etc/modules-load.d
printf 'erofs\noverlay\n' > /etc/modules-load.d/atelier-system.conf

installed=0
if docker container inspect "$system_name" >/dev/null 2>&1; then installed=1; fi
if [ "$installed" -eq 0 ] && docker container inspect atelier >/dev/null 2>&1; then
  fail "an old Atelier container exists; this installer does not migrate old installations"
fi
if [ "$installed" -eq 0 ]; then
  case "$action" in ""|install|update) action=install ;; *) fail "Atelier System is not installed" ;; esac
elif [ "$action" = install ]; then
  fail "Atelier System is already installed; use --action update"
fi

# Read through System's CLI so the host needs neither Tailscale nor a JSON parser.
tailscale_details() {
  docker exec "$system_name" bun -e '
    const p = Bun.spawnSync(["tailscale", "status", "--json"]);
    if (p.exitCode) process.exit(p.exitCode);
    const s = JSON.parse(p.stdout.toString());
    console.log(s.BackendState);
    console.log((s.Self?.DNSName ?? "").replace(/\.$/, ""));
  '
}

wait_for_tailscale() {
  local attempt
  for ((attempt=0; attempt<60; attempt++)); do
    if details="$(tailscale_details 2>/dev/null)"; then return; fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$system_name")" != true ]; then
      docker logs --tail 80 "$system_name" >&2
      fail "System stopped during startup"
    fi
    sleep 1
  done
  fail "Tailscale did not start within 60 seconds; inspect: docker logs $system_name"
}

show_url() {
  details="$(tailscale_details)"
  if [ "${details%%$'\n'*}" != Running ]; then
    printf 'Tailscale is not connected. Run:\n  docker exec -it %s tailscale up\n' "$system_name"
    return
  fi
  local hostname="${details#*$'\n'}"
  [ -n "$hostname" ] || fail "Tailscale is running but has no DNS name"
  printf 'Open Atelier: https://%s\nDiagnostics: https://%s:8443\n' "$hostname" "$hostname"
}

pulled=0
pull_system() {
  printf 'Downloading System image before interrupting the running installation...\n'
  docker pull "$system_image"
  pulled=1
}

if [ -z "$action" ]; then
  if [ "$non_interactive" -eq 1 ]; then
    action=update
  else
    pull_system
    current_image="$(docker inspect --format '{{.Image}}' "$system_name")"
    latest_image="$(docker image inspect --format '{{.Id}}' "$system_image")"
    if [ "$current_image" = "$latest_image" ]; then
      printf 'System image is up to date. Update can recreate it.\n'
    else
      printf 'A System update is downloaded and ready.\n'
    fi
    if details="$(tailscale_details 2>/dev/null)" && [ "${details%%$'\n'*}" = Running ]; then
      printf 'Tailscale is connected.\n'
    else
      printf 'Tailscale is not connected or System is stopped.\n'
    fi
    printf 'Choose: connect, update, open, or quit: '
    IFS= read -r action </dev/tty || fail "no terminal; specify --non-interactive or --action"
    [ "$action" != quit ] || exit 0
    case "$action" in connect|update|open) ;; *) fail "unknown action: $action" ;; esac
  fi
fi

case "$action" in
  install|update)
    [ "$pulled" -eq 1 ] || pull_system
    if [ "$installed" -eq 1 ]; then
      printf 'Stopping System; running workspaces will be interrupted...\n'
      docker stop --time 120 "$system_name"
      docker rm "$system_name"
    fi
    docker run -d --name "$system_name" --hostname atelier-system --privileged --restart unless-stopped \
      --stop-timeout 120 --tmpfs /run --mount source=atelier-system,target=/data \
      "$system_image" --app-image "$app_image"
    wait_for_tailscale
    if [ "${details%%$'\n'*}" != Running ] && [ "$non_interactive" -eq 0 ]; then
      printf 'Connect Atelier to your tailnet now? [Y/n]: '
      IFS= read -r answer </dev/tty || fail "no terminal; rerun with --action connect"
      case "$answer" in ""|y|Y|yes) docker exec "$system_name" tailscale up ;; esac
    fi
    show_url ;;
  connect)
    if [ "$(docker inspect --format '{{.State.Running}}' "$system_name")" != true ]; then
      docker start "$system_name" >/dev/null
    fi
    wait_for_tailscale
    docker exec "$system_name" tailscale up
    show_url ;;
  open) show_url ;;
esac
