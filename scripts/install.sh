#!/usr/bin/env bash
set -Eeuo pipefail

system_image=ghcr.io/lucasmeijer/atelier-system:latest
app_image=ghcr.io/lucasmeijer/atelier:stable
action=""
access_mode=""
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
spinner_frame=0
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
  local frame="${frames:spinner_frame:1}"
  spinner_frame=$(((spinner_frame + 1) % 10))
  if [ -n "$percent" ]; then
    for ((i=0; i<10; i++)); do
      if [ "$i" -lt "$((percent/10))" ]; then bar+="━"; else bar+="─"; fi
    done
    suffix="$bar $percent%"
  elif [[ "$text" == *" · "*" layers ready" ]]; then
    suffix="${text##* · }  $elapsed"
    text="${text% · *}"
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
    sleep 0.1
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
  --access-mode MODE  localhost or tailscale (default selected for this machine)
  --action ACTION     install, update, connect, or open
  --non-interactive   Install/update without prompts; print login instructions
  -h, --help          Show help

The app image is only used when System has no persisted app selection.
There is no migration from the previous Atelier installation layout.
HELP
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --system-image|--app-image|--action|--access-mode)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"
      case "$1" in
        --system-image) system_image="$2" ;;
        --app-image) app_image="$2" ;;
        --action) action="$2" ;;
        --access-mode) access_mode="$2" ;;
      esac
      shift 2 ;;
    --non-interactive) non_interactive=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
case "$action" in ""|install|update|connect|open) ;; *) fail "unknown action: $action" ;; esac
case "$access_mode" in ""|localhost|tailscale) ;; *) fail "unknown access mode: $access_mode" ;; esac
host_os="$(uname -s)"
desktop=0
if [ "$host_os" = Darwin ] || { [ "$host_os" = Linux ] && grep -qi microsoft /proc/sys/kernel/osrelease; }; then desktop=1; fi
case "$host_os" in
  Linux) [ "$(id -u)" -eq 0 ] || fail "run this installer as root" ;;
  Darwin)
    # Docker Desktop belongs to the logged-in user, including when the installer
    # was invoked with sudo. Keep that user's Docker context and credentials.
    if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
      docker_binary="$(command -v docker)" || fail "install and start Docker Desktop first"
      docker() { sudo -H -u "$SUDO_USER" "$docker_binary" "$@"; }
    fi ;;
  *) fail "Atelier System requires Linux or macOS with Docker Desktop" ;;
esac

log_file="$(mktemp /tmp/atelier-install.XXXXXX)"
printf "\n  %sLet's get your Atelier setup!%s\n\n" "$violet" "$reset"
status "Preparing your server"
if ! command -v docker >/dev/null; then
  [ "$host_os" != Darwin ] || fail "install and start Docker Desktop first, then run this installer again"
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
if [ "$host_os" = Linux ] && [ "$desktop" -eq 0 ]; then
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
fi

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
  local reply previous="" activity_start=$SECONDS start=$SECONDS description="Waiting for the supervisor" percent="" code pid status_file tick
  status_file="${log_file}.status"
  local request_connect=0 last_action="" current_action app_url
  local -a fields
  [ "$action" != connect ] || request_connect=1
  while true; do
    [ "$(docker inspect --format '{{.State.Running}}' "$system_name" 2>>"$log_file")" = true ] || fail "Atelier services stopped during startup."
    if [ "$request_connect" -eq 1 ]; then
      if supervisor_connect >>"$log_file" 2>&1; then request_connect=0; fi
    fi
    supervisor_status >"$status_file" 2>>"$log_file" &
    pid=$!
    active_pid=$pid
    while kill -0 "$pid" 2>/dev/null; do
      status "$description" "$((SECONDS-activity_start))s" "$percent"
      sleep 0.1
    done
    active_pid=""
    code=0
    wait "$pid" || code=$?
    reply="$(cat "$status_file")"
    if [ "$code" -eq 0 ]; then
      fields=()
      while IFS= read -r field; do fields+=("$field"); done <<<"$reply"
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
      [ "$code" -ne 2 ] || fail "The supervisor returned an invalid status."
      description="Waiting for the supervisor"; percent=""
    fi
    if [ "${description%% · *}" != "$previous" ]; then activity_start=$SECONDS; previous="${description%% · *}"; fi
    status "$description" "$((SECONDS-activity_start))s" "$percent"
    [ "$((SECONDS-start))" -lt 2400 ] || fail "Atelier did not finish starting within 40 minutes."
    for ((tick=0; tick<10; tick++)); do
      status "$description" "$((SECONDS-activity_start))s" "$percent"
      sleep 0.1
    done
  done
  rm "$status_file"
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
    if [ "$installed" -eq 0 ] && [ -z "$access_mode" ]; then
      if [ "$desktop" -eq 1 ]; then access_mode=localhost; else access_mode=tailscale; fi
      if [ "$non_interactive" -eq 0 ]; then
        finish_line
        local_caption="I'm installing this on my dev machine, no need for remote access now"
        remote_caption="I'm installing this on a server so I can control my agents from anywhere"
        if [ "$access_mode" = localhost ]; then
          first_caption="$local_caption"; second_caption="$remote_caption"; alternate_mode=tailscale
        else
          first_caption="$remote_caption"; second_caption="$local_caption"; alternate_mode=localhost
        fi
        printf '  1. %s\n' "$first_caption"
        printf '  %s2. %s%s\n' "$dim" "$second_caption" "$reset"
        printf '  Choose [1]: '
        IFS= read -r answer </dev/tty || fail "no terminal; specify --non-interactive"
        case "${answer:-1}" in 1) ;; 2) access_mode="$alternate_mode" ;; *) fail "choose 1 or 2" ;; esac
      fi
    fi
    run_quiet "Downloading Atelier services" docker pull "$system_image"
    if [ "$desktop" -eq 1 ]; then
      run_quiet "Checking Docker Desktop kernel" docker run --rm --entrypoint /bin/sh "$system_image" -ec '
        for filesystem in erofs overlay; do
          grep -qw "$filesystem" /proc/filesystems || {
            echo "$filesystem is unavailable in Docker Desktop; update Docker Desktop" >&2
            exit 1
          }
        done
      '
    fi
    if [ "$installed" -eq 1 ]; then
      run_quiet "Stopping Atelier services" docker stop --time 120 "$system_name"
      run_quiet "Replacing Atelier services" docker rm "$system_name"
    fi
    run_quiet "Starting Atelier services" docker run -d --name "$system_name" --hostname atelier-system --privileged --cgroupns=host --restart unless-stopped \
      --stop-timeout 120 --tmpfs /run --mount source=atelier-system,target=/data --publish 127.0.0.1::3080 \
      "$system_image" --app-image "$app_image" --access-mode "${access_mode:-tailscale}"
    ;;
  connect)
    if [ "$(docker inspect --format '{{.State.Running}}' "$system_name")" != true ]; then
      run_quiet "Starting Atelier services" docker start "$system_name"
    fi
    ;;
  open) ;;
esac
if [ "$action" = install ] || [ "$action" = update ]; then
  local_port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "3080/tcp") 0).HostPort}}' "$system_name")"
  for ((attempt=0; attempt<60; attempt++)); do
    if docker exec "$system_name" bun -e '
      const [localPort, mode] = process.argv.slice(1);
      const response = await fetch("http://127.0.0.1:3001/access", {
        method: "POST", headers: {"content-type":"application/json"},
        body: JSON.stringify({localPort:Number(localPort), ...(mode ? {mode} : {})}),
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`System access setup: ${response.status}`);
    ' "$local_port" "$access_mode" >>"$log_file" 2>&1; then break; fi
    sleep 1
  done
  [ "$attempt" -lt 60 ] || fail "Could not configure local access"
fi
wait_for_system
