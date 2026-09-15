#!/usr/bin/env bash
set -Eeuo pipefail

system_image=ghcr.io/lucasmeijer/atelier-system:latest
app_image=ghcr.io/lucasmeijer/atelier:stable
action=""
non_interactive=0
system_name=atelier-system

# Keep subprocess output available without turning the welcome into a log tail.
log_file=""
interactive=0
violet="" cyan="" green="" amber="" dim="" reset=""
if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
  interactive=1
  violet=$'\033[35m' cyan=$'\033[36m' green=$'\033[32m'
  amber=$'\033[33m' dim=$'\033[2m' reset=$'\033[0m'
fi
last_status=""
supervisor_url=""
active_pid=""

finish_line() {
  if [ "$interactive" -eq 1 ] && [ -n "$last_status" ]; then printf '\r\033[2K'; fi
  last_status=""
}
status() {
  local text="$1" elapsed="${2:-}" percent="${3:-}" bar="" i suffix
  local rows columns available
  local frames="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  local frame="${frames:SECONDS%10:1}"
  if [ -n "$percent" ]; then
    for ((i=0; i<10; i++)); do
      if [ "$i" -lt "$((percent/10))" ]; then bar+="━"; else bar+="─"; fi
    done
    suffix="$bar $percent%"
  else
    suffix="$elapsed"
  fi
  if [ "$interactive" -eq 1 ]; then
    read -r rows columns < <(stty size </dev/tty)
    available=$((columns - 8 - ${#suffix}))
    if [ "$available" -lt 10 ]; then available=10; fi
    if [ "${#text}" -gt "$available" ]; then text="${text:0:available-1}…"; fi
    printf '\r\033[2K  %s%s %s%s  %s%s%s' "$cyan" "$frame" "$text" "$reset" "$dim" "$suffix" "$reset"
  elif [ "$1" != "$last_status" ]; then
    printf '  %s\n' "$text"
  fi
  last_status="$1"
}
fail() {
  finish_line
  printf '\n  %s! %s%s\n' "$amber" "$*" "$reset" >&2
  if [ -n "$supervisor_url" ]; then
    printf '  Open supervisor: %s\n' "$supervisor_url" >&2
  else
    printf '  Local diagnostics: docker logs %s\n' "$system_name" >&2
  fi
  [ -z "$log_file" ] || printf '  Bootstrap log: %s\n' "$log_file" >&2
  exit 1
}
run_quiet() {
  local label="$1" pid start=$SECONDS code=0
  shift
  "$@" >>"$log_file" 2>&1 &
  pid=$!
  active_pid=$pid
  while kill -0 "$pid" 2>/dev/null; do
    status "$label" "$((SECONDS-start))s"
    if [ "$((SECONDS-start))" -ge 1800 ]; then
      kill "$pid"
      wait "$pid" || :
      active_pid=""
      fail "Timed out: $label."
    fi
    sleep 1
  done
  active_pid=""
  wait "$pid" || code=$?
  [ "$code" -eq 0 ] || fail "$label failed. See the bootstrap log for details."
}
cleanup() {
  finish_line
  if [ -n "$active_pid" ] && kill -0 "$active_pid" 2>/dev/null; then
    kill "$active_pid"
    wait "$active_pid" || :
  fi
}
trap cleanup EXIT
trap 'fail "Installation could not continue. See the bootstrap log for details."' ERR
trap 'fail "Installation interrupted."' INT TERM

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

log_file="$(mktemp /tmp/atelier-install.XXXXXX.log)"
printf "\n  %sWelcome to your Atelier!%s\n  %sLet's get you setup.%s\n\n" "$violet" "$reset" "$dim" "$reset"
status "Preparing your server"
if ! command -v docker >/dev/null; then
  if command -v apt-get >/dev/null; then
    run_quiet "Preparing your server · installing Docker" apt-get update
    run_quiet "Preparing your server · installing Docker" apt-get install -y docker.io
  elif command -v dnf >/dev/null; then
    run_quiet "Preparing your server · installing Docker" dnf install -y docker
  else
    fail "install Docker first; automatic Docker installation supports apt-get and dnf"
  fi
  run_quiet "Starting Docker" systemctl enable --now docker
fi
run_quiet "Checking Docker" docker info

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

# The supervisor owns app lifecycle and routing. Query locally so the host
# does not need tailnet access, curl, or a JSON parser.
supervisor_status() {
  docker exec "$system_name" bun -e '
    const r = await fetch("http://127.0.0.1:3001/status", {signal: AbortSignal.timeout(3000)});
    if (!r.ok) throw new Error(`Supervisor status: ${r.status}`);
    const clean = (text) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    const url = (value) => {
      if (value === undefined) return "";
      if (typeof value !== "string" || !/^https?:$/.test(new URL(value).protocol) || /[\x00-\x20\x7f]/.test(value))
        throw new Error("Invalid System destination");
      return value;
    };
    try {
      const s = await r.json();
      const a = s.activity;
      if (!["starting", "ready", "failed"].includes(s.state) ||
          typeof a?.description !== "string" || !a.description.trim() ||
          (a.percent !== undefined && (typeof a.percent !== "number" ||
            !Number.isFinite(a.percent) || a.percent < 0 || a.percent > 100))) {
        throw new Error("Invalid supervisor status contract");
      }
      const appUrl = url(s.appUrl);
      if (s.state === "ready" && !appUrl) throw new Error("Ready without an app destination");
      console.log([
        s.state, clean(a.description), a.percent === undefined ? "" : Math.floor(a.percent),
        appUrl, url(s.supervisorUrl), clean(s.action?.description ?? ""), url(s.action?.url),
        clean(s.diagnostics?.description ?? ""), ...(s.diagnostics?.lines ?? []).map(clean),
      ].join("\n"));
    } catch (error) {
      console.error(error);
      process.exit(2);
    }
  '
}
supervisor_connect() {
  docker exec "$system_name" bun -e '
    const r = await fetch("http://127.0.0.1:3001/connect", {
      method: "POST", signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(`System connection request: ${r.status}`);
  '
}
wait_for_system() {
  local reply previous="" activity_start=$SECONDS start=$SECONDS description percent code
  local request_connect=0 last_action="" current_action app_url
  local -a fields
  [ "$action" != connect ] || request_connect=1
  while true; do
    [ "$(docker inspect --format '{{.State.Running}}' "$system_name" 2>>"$log_file")" = true ] || fail "Atelier services stopped during startup."
    if [ "$request_connect" -eq 1 ]; then
      if supervisor_connect >>"$log_file" 2>&1; then request_connect=0; fi
    fi
    if reply="$(supervisor_status 2>>"$log_file")"; then
      mapfile -t fields <<<"$reply"
      description="${fields[1]}"
      percent="${fields[2]:-}"
      app_url="${fields[3]:-}"
      supervisor_url="${fields[4]:-}"
      current_action="${fields[5]:-}"$'\n'"${fields[6]:-}"
      if [ -n "${fields[5]:-}" ] && [ "$current_action" != "$last_action" ]; then
        finish_line
        printf '\n  %s\n' "${fields[5]}"
        [ -z "${fields[6]:-}" ] || printf '\n  %s\n\n' "${fields[6]}"
        last_action="$current_action"
      fi
      case "${fields[0]}" in
        ready) [ "$request_connect" -ne 0 ] || break ;;
        failed)
          finish_line
          printf '\n  %s! %s%s\n' "$amber" "$description" "$reset" >&2
          [ -z "$supervisor_url" ] || printf '  Open supervisor: %s\n' "$supervisor_url" >&2
          [ -z "${fields[7]:-}" ] || printf '  %s\n' "${fields[7]}" >&2
          if [ "${#fields[@]}" -gt 8 ]; then printf '  %s\n' "${fields[@]:8}" >&2; fi
          exit 1 ;;
        starting)
          if [ "$non_interactive" -eq 1 ] && [ -n "${fields[5]:-}" ]; then
            printf '  Run the installer again after completing this action.\n'
            return
          fi ;;
      esac
    else
      code=$?
      [ "$code" -ne 2 ] || fail "The supervisor returned an invalid status."
      description="Waiting for the supervisor"; percent=""
    fi
    if [ "$description" != "$previous" ]; then activity_start=$SECONDS; previous="$description"; fi
    status "$description" "$((SECONDS-activity_start))s" "$percent"
    [ "$((SECONDS-start))" -lt 2400 ] || fail "Atelier did not finish starting within 40 minutes."
    sleep 1
  done
  finish_line
  printf '  %s✓ %s%s\n\n  Open %s\n\n' "$green" "$description" "$reset" "$app_url"
}

if [ -z "$action" ]; then
  if [ "$non_interactive" -eq 1 ]; then
    action=update
  else
    finish_line
    printf '  Welcome back.\n'
    printf '  Choose: open, update, connect, or quit: '
    IFS= read -r action </dev/tty || fail "no terminal; specify --non-interactive or --action"
    [ "$action" != quit ] || exit 0
    case "$action" in connect|update|open) ;; *) fail "unknown action: $action" ;; esac
  fi
fi

case "$action" in
  install|update)
    if [ "$installed" -eq 1 ]; then
      finish_line
      printf '  %sUpdating interrupts running workspaces.%s\n' "$amber" "$reset"
      if [ "$non_interactive" -eq 0 ]; then
        printf '  Continue? [y/N]: '
        IFS= read -r answer </dev/tty || fail "no terminal; specify --non-interactive"
        case "$answer" in y|Y|yes) ;; *) exit 0 ;; esac
      fi
    fi
    run_quiet "Downloading Atelier services" docker pull "$system_image"
    if [ "$installed" -eq 1 ]; then
      run_quiet "Stopping Atelier services" docker stop --time 120 "$system_name"
      run_quiet "Replacing Atelier services" docker rm "$system_name"
    fi
    run_quiet "Starting Atelier services" docker run -d --name "$system_name" --hostname atelier-system --privileged --cgroupns=host --restart unless-stopped \
      --stop-timeout 120 --tmpfs /run --mount source=atelier-system,target=/data \
      "$system_image" --app-image "$app_image"
    ;;
  connect)
    if [ "$(docker inspect --format '{{.State.Running}}' "$system_name")" != true ]; then
      run_quiet "Starting Atelier services" docker start "$system_name"
    fi
    ;;
  open) ;;
esac
wait_for_system
