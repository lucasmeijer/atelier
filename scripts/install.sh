#!/usr/bin/env bash
set -euo pipefail

atelier_repository="ghcr.io/lucasmeijer/atelier"
atelier_channel="stable"
atelier_image=""
atelier_name="atelier"
atelier_data_dir="/var/lib/atelier"
atelier_port="80"
atelier_workspace_slice="atelier-workspaces.slice"
atelier_reserved_memory_bytes=$((2 * 1024 * 1024 * 1024))
workspace_memory_bytes=""
cpu_count=""
workspace_cpu_quota=""
pull_only=0

if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ -n "${TERM:-}" ]; then
  green="$(tput setaf 2)"
  blue="$(tput setaf 4)"
  yellow="$(tput setaf 3)"
  red="$(tput setaf 1)"
  bold="$(tput bold)"
  reset="$(tput sgr0)"
else
  green=""
  blue=""
  yellow=""
  red=""
  bold=""
  reset=""
fi

log() {
  printf '%s\n' "$*"
}

info() {
  printf '%s›%s %s\n' "$blue" "$reset" "$*"
}

success() {
  printf '%s✓%s %s\n' "$green" "$reset" "$*"
}

warning() {
  printf '%s!%s %s\n' "$yellow" "$reset" "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

fail_tailscale_serve_not_enabled() {
  cat >&2 <<'EOF'
error: Atelier needs Tailscale Serve over HTTPS, but this tailnet is not ready for it.

Enable HTTPS certificates for your tailnet:

  1. Open https://login.tailscale.com/admin/dns
  2. Enable MagicDNS
  3. Enable HTTPS Certificates
  4. Rerun this installer

Atelier uses Tailscale Serve, not Funnel. It stays private to your tailnet.
EOF
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --channel <stable|latest>  Atelier release channel to install (default: stable)
  --image <image>            Exact Atelier image reference to install
  --pull-only                Install/start Docker and pull required images, then exit
  -h, --help                 Show this help

Examples:
  curl -fsSL https://lucasmeijer.com/get-atelier | sudo bash
  curl -fsSL https://lucasmeijer.com/get-atelier | sudo bash -s -- --channel latest
  curl -fsSL https://lucasmeijer.com/get-atelier | sudo bash -s -- --image ghcr.io/lucasmeijer/atelier:v0.1.0
EOF
}

parse_args() {
  image_specified=0
  channel_specified=0

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --channel)
        [ "$#" -ge 2 ] || fail "--channel requires a value"
        atelier_channel="$2"
        channel_specified=1
        shift 2
        ;;
      --channel=*)
        atelier_channel="${1#--channel=}"
        channel_specified=1
        shift
        ;;
      --image)
        [ "$#" -ge 2 ] || fail "--image requires a value"
        atelier_image="$2"
        image_specified=1
        shift 2
        ;;
      --image=*)
        atelier_image="${1#--image=}"
        image_specified=1
        shift
        ;;
      --pull-only)
        pull_only=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "unknown option: $1"
        ;;
    esac
  done

  [ "$image_specified" -eq 0 ] || [ "$channel_specified" -eq 0 ] || fail "--image and --channel cannot be used together"
  if [ "$image_specified" -eq 0 ]; then
    case "$atelier_channel" in
      stable|latest) ;;
      *) fail "unsupported channel: $atelier_channel (expected stable or latest)" ;;
    esac
    atelier_image="$atelier_repository:$atelier_channel"
  fi
  [ -n "$atelier_image" ] || fail "image reference cannot be empty"
  if [ "$image_specified" -eq 1 ]; then
    case "$atelier_image" in
      *:latest) atelier_channel="latest" ;;
      *) atelier_channel="stable" ;;
    esac
  fi
}

unsupported_day_to_day_computer() {
  cat >&2 <<'EOF'
Atelier is not software you should install on your day to day computer.
You put it on a cloud computer. I rent mine at hetzner.de, other people use Digital Ocean, exe.dev, or they use a linux server they have laying around.
EOF
  exit 1
}

require_linux() {
  case "$(uname -s)" in
    Linux)
      success "Linux detected"
      ;;
    Darwin|MINGW*|MSYS*|CYGWIN*)
      unsupported_day_to_day_computer
      ;;
    *)
      fail "this installer only supports Linux"
      ;;
  esac
}

require_root() {
  [ "${EUID:-$(id -u)}" -eq 0 ] || fail "run this installer as root, for example: curl -fsSL https://lucasmeijer.com/get-atelier | sudo bash"
  success "Running as root"
}

require_interactive_terminal() {
  local terminal_fd

  if ! { exec {terminal_fd}</dev/tty; } 2>/dev/null; then
    cat >&2 <<'EOF'
error: Atelier installation requires an interactive terminal for setup questions.
No changes have been made by this installer.

Run this installer inside tmux on the machine where you are installing Atelier:

  tmux new-session -d -s atelier-install

Rerun your original installer command, including its options, in that session
using tmux send-keys. Monitor output and respond to setup questions with:

  tmux capture-pane -p -t atelier-install -S -100
  tmux send-keys -t atelier-install 'YOUR ANSWER' Enter

Show the user the live terminal when your tools support it; otherwise relay
progress and any required actions. Share Tailscale sign-in links with the user
for approval. Keep monitoring until the installer succeeds or fails; starting
the tmux session does not mean installation is complete.

To view the session interactively:

  tmux attach-session -t atelier-install

Install tmux first if it is not available. --help and --pull-only do not require
a terminal.
EOF
    exit 1
  fi
  exec {terminal_fd}<&-
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

ssh_connection_from_process_tree() {
  local pid ppid value

  pid="$$"
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ -r "/proc/$pid/status" ]; do
    value="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | awk -F= '$1 == "SSH_CONNECTION" || $1 == "SSH_CLIENT" { print $2; exit }')"
    if [ -n "$value" ]; then
      printf '%s\n' "$value"
      return 0
    fi
    ppid="$(awk '/^PPid:/ { print $2 }' "/proc/$pid/status")"
    [ -n "$ppid" ] && [ "$ppid" != "$pid" ] || return 0
    pid="$ppid"
  done
}

ssh_connection_value() {
  if [ -n "${SSH_CONNECTION:-}" ]; then
    printf '%s\n' "$SSH_CONNECTION"
    return 0
  fi
  if [ -n "${SSH_CLIENT:-}" ]; then
    printf '%s\n' "$SSH_CLIENT"
    return 0
  fi
  ssh_connection_from_process_tree || true
}

ssh_client_ip() {
  local value

  value="$(ssh_connection_value || true)"
  if [ -n "$value" ]; then
    printf '%s\n' "$value" | awk '{ print $1 }'
    return 0
  fi

  who -m 2>/dev/null | sed -n 's/.*(\([^)]*\)).*/\1/p' | head -n 1
  return 0
}

latency_rating() {
  local latency_ms="$1"

  if [ "$latency_ms" -le 20 ]; then
    printf 'great\n'
  elif [ "$latency_ms" -le 35 ]; then
    printf 'good\n'
  elif [ "$latency_ms" -le 80 ]; then
    printf 'poor\n'
  else
    printf 'bad\n'
  fi
}

measure_latency() {
  local client_ip="$1"
  local latency_output="$2"
  local ssh_client_address ssh_client_port ssh_server_address ssh_server_port

  if [ -n "${SSH_CONNECTION:-}" ] && command_exists ss; then
    read -r ssh_client_address ssh_client_port ssh_server_address ssh_server_port <<<"$SSH_CONNECTION"
    ss -tin "src $ssh_server_address:$ssh_server_port dst $ssh_client_address:$ssh_client_port" >"$latency_output" 2>&1
    grep -q 'rtt:' "$latency_output" && return
  fi

  command_exists ping || return 1
  ping -c 4 -W 2 "$client_ip" >"$latency_output" 2>&1
}

wait_with_spinner() {
  local pid="$1"
  local message="$2"
  local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0

  if [ ! -t 1 ]; then
    info "$message..."
    wait "$pid"
    return
  fi

  tput civis 2>/dev/null || true
  info "$message..."
  while kill -0 "$pid" 2>/dev/null; do
    printf '\r%s%s%s %s...' "$blue" "${frames:i++%${#frames}:1}" "$reset" "$message"
    sleep 0.1
  done
  printf '\r\033[K'
  tput cnorm 2>/dev/null || true
  wait "$pid"
}

confirm_continue_for_latency() {
  local latency_ms="$1"
  local rating="$2"
  local answer

  printf '%s\n' "We're measuring ${latency_ms}ms latency between you and the computer you're installing Atelier on. This is ${rating}. For best experience install Atelier on a computer that is closer to your location."
  printf 'Continue anyway y/n: '
  IFS= read -r answer </dev/tty || fail "could not read confirmation from terminal"
  case "$answer" in
    y|Y|yes|YES|Yes) ;;
    *) fail "installation cancelled" ;;
  esac
}

check_ssh_latency() {
  local client_ip latency_output latency_ms rating ssh_connection

  ssh_connection="$(ssh_connection_value || true)"
  client_ip="$(ssh_client_ip)"
  [ -n "$client_ip" ] || return 0

  latency_output="$(mktemp)"
  SSH_CONNECTION="$ssh_connection" measure_latency "$client_ip" "$latency_output" &
  if wait_with_spinner "$!" "Measuring latency"; then
    latency_ms="$(sed -n 's/.*rtt:\([0-9.]*\)\/.*/\1/p' "$latency_output" | head -n 1 | awk '{ printf "%.0f", $1 }')"
    if [ -z "$latency_ms" ]; then
      latency_ms="$(awk -F'/' '/^(rtt|round-trip)/ { found = 1; printf "%.0f", $2 } END { if (!found) exit 1 }' "$latency_output" || true)"
    fi
    rm -f "$latency_output"
    [ -n "$latency_ms" ] || return 0
    rating="$(latency_rating "$latency_ms")"

    case "$rating" in
      great) success "Latency to your SSH client: ${latency_ms}ms (${green}${rating}${reset})" ;;
      good) success "Latency to your SSH client: ${latency_ms}ms (${rating})" ;;
      poor) warning "Latency to your SSH client: ${latency_ms}ms (${rating})" ;;
      bad) warning "Latency to your SSH client: ${latency_ms}ms (${red}${rating}${reset})" ;;
    esac

    case "$rating" in
      bad) confirm_continue_for_latency "$latency_ms" "$rating" ;;
    esac
  else
    rm -f "$latency_output"
  fi
}

require_supported_host() {
  local command controllers total_memory_kib total_memory_bytes

  info "Checking host requirements..."
  for command in awk cat curl getconf grep head mktemp ps sed timeout tr; do
    command_exists "$command" || fail "$command is required to install Atelier"
  done
  command_exists systemctl || fail "Atelier workspace resource isolation requires systemd"
  [ "$(ps -p 1 -o comm= | tr -d ' ')" = systemd ] || fail "Atelier workspace resource isolation requires systemd as PID 1"
  [ -f /sys/fs/cgroup/cgroup.controllers ] || fail "Atelier requires cgroup v2 for workspace resource isolation; this host appears to use cgroup v1"

  controllers=" $(cat /sys/fs/cgroup/cgroup.controllers) "
  for controller in cpu io memory pids; do
    case "$controllers" in
      *" $controller "*) ;;
      *) fail "Atelier requires the cgroup v2 $controller controller" ;;
    esac
  done

  total_memory_kib="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo)"
  total_memory_bytes=$((total_memory_kib * 1024))
  workspace_memory_bytes=$((total_memory_bytes - atelier_reserved_memory_bytes))
  [ "$workspace_memory_bytes" -ge $((1024 * 1024 * 1024)) ] || fail "Atelier requires at least 3 GiB of memory: 2 GiB is reserved for Atelier and the host"

  cpu_count="$(getconf _NPROCESSORS_ONLN)"
  [ "$cpu_count" -ge 2 ] || fail "Atelier requires at least 2 logical CPUs: one CPU is reserved from workspace use"
  workspace_cpu_quota=$(((cpu_count - 1) * 100))

  if ! command_exists docker \
    && ! command_exists apt-get \
    && ! command_exists dnf \
    && ! command_exists yum \
    && ! command_exists zypper \
    && ! command_exists pacman; then
    fail "could not find Docker or a supported package manager to install it"
  fi

  success "Host requirements met: $((workspace_memory_bytes / 1024 / 1024)) MiB and $((cpu_count - 1)) CPU(s) available to workspaces"
}

install_docker() {
  if command_exists docker; then
    success "Docker is already installed"
    return
  fi

  info "Docker is not installed; installing Docker..."

  if command_exists apt-get; then
    apt-get update
    apt-get install -y docker.io
  elif command_exists dnf; then
    dnf install -y docker
  elif command_exists yum; then
    yum install -y docker
  elif command_exists zypper; then
    zypper --non-interactive install docker
  elif command_exists pacman; then
    pacman -Sy --noconfirm docker
  else
    fail "could not find a supported package manager to install Docker"
  fi

  success "Docker installed"
}

start_docker() {
  info "Starting Docker..."

  if command_exists systemctl; then
    systemctl enable --now docker
  elif command_exists service; then
    service docker start
  else
    fail "could not start Docker; systemctl/service is unavailable"
  fi

  docker info >/dev/null
  success "Docker is running"
}

confirm_tailscale_setup() {
  local question="$1"
  local answer

  log "$question"
  printf 'Continue? [Y/n]: '
  IFS= read -r answer </dev/tty || fail "could not read Tailscale setup confirmation from terminal"
  case "$answer" in
    ""|y|Y|yes|YES|Yes) ;;
    *) fail "installation cancelled; Atelier requires a connected Tailscale tailnet" ;;
  esac
}

install_tailscale() {
  command_exists curl || fail "curl is required to install Tailscale"

  info "Running the official Tailscale installer..."
  curl -fsSL https://tailscale.com/install.sh | sh
  command_exists tailscale || fail "the Tailscale installer finished, but the tailscale command is unavailable"
  success "Tailscale installed"
}

start_tailscale_daemon() {
  info "Starting Tailscale..."

  if command_exists systemctl && systemctl list-unit-files tailscaled.service >/dev/null 2>&1; then
    systemctl enable --now tailscaled
  elif command_exists service; then
    service tailscaled start
  else
    fail "could not start tailscaled; systemctl/service is unavailable"
  fi
}

wait_for_tailscale_status() {
  local status_json="$1"
  local attempt=0

  while [ "$attempt" -lt 20 ]; do
    if tailscale status --json >"$status_json" 2>/dev/null; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  return 1
}

connect_tailscale() {
  log ""
  log "Tailscale will print a sign-in link if this machine needs approval."
  log "Open that link on your computer and approve the machine. Keep this installer running; it will wait for the tailnet to come up."
  log ""
  tailscale up --timeout=0s
}

require_tailscale() {
  local status_json backend_state setup_approved=0

  if ! command_exists tailscale; then
    log "Tailscale is not installed. Atelier uses it to give you a private HTTPS address without exposing Atelier to the public internet."
    confirm_tailscale_setup "Run the official installer from https://tailscale.com/install.sh and connect this machine now?"
    install_tailscale
    setup_approved=1
  else
    success "Tailscale is already installed"
  fi

  status_json="$(mktemp)"
  if ! tailscale status --json >"$status_json" 2>/dev/null; then
    start_tailscale_daemon
    wait_for_tailscale_status "$status_json" || {
      tailscale status --json || true
      fail "could not connect to tailscaled"
    }
  fi

  backend_state="$(sed -n 's/.*"BackendState": *"\([^"]*\)".*/\1/p' "$status_json" | head -n 1)"
  if [ "$backend_state" != Running ]; then
    if [ "$setup_approved" -eq 0 ]; then
      log "Tailscale is installed, but this machine is not connected to a tailnet (state: ${backend_state:-unknown})."
      confirm_tailscale_setup "Connect it now with 'tailscale up'?"
    fi
    connect_tailscale
    wait_for_tailscale_status "$status_json" || fail "Tailscale did not come up"
    backend_state="$(sed -n 's/.*"BackendState": *"\([^"]*\)".*/\1/p' "$status_json" | head -n 1)"
    [ "$backend_state" = Running ] || fail "Tailscale did not come up (state: ${backend_state:-unknown})"
  fi

  [ -S /var/run/tailscale/tailscaled.sock ] || fail "tailscaled local API socket not found"
  tailscale_ip="$(tailscale ip -4 | head -n 1)"
  [ -n "$tailscale_ip" ] || fail "could not determine this machine's Tailscale IPv4 address"

  tailscale_dns="$(sed -n 's/.*"DNSName": "\([^"]*\)".*/\1/p' "$status_json" | head -n 1 | sed 's/\.$//')"
  [ -n "$tailscale_dns" ] || fail_tailscale_serve_not_enabled
  atelier_public_host="$tailscale_dns"

  grep -Fq '"https"' "$status_json" || fail_tailscale_serve_not_enabled
  grep -Fq "\"$atelier_public_host\"" "$status_json" || fail_tailscale_serve_not_enabled

  rm -f "$status_json"
  success "Tailscale is up: $atelier_public_host"
}

configure_tailscale_serve() {
  local config_file output_file

  info "Configuring Tailscale Serve for Atelier..."
  config_file="$(mktemp)"
  output_file="$(mktemp)"

  {
    printf '{"TCP":{"443":{"HTTPS":true},"81":{"HTTPS":true}}'
    printf ',"Web":{"%s:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:%s/"}}},"%s:81":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:81/"}}}}}\n' "$atelier_public_host" "$atelier_port" "$atelier_public_host"
  } >"$config_file"

  if ! curl -fsS --unix-socket /var/run/tailscale/tailscaled.sock \
    -X POST \
    --data-binary "@$config_file" \
    http://local-tailscaled.sock/localapi/v0/serve-config >"$output_file" 2>&1; then
    cat "$output_file" >&2
    rm -f "$config_file" "$output_file"
    fail_tailscale_serve_not_enabled
  fi

  rm -f "$config_file" "$output_file"
  success "Tailscale Serve config is ready: https://$atelier_public_host/"
}

prepare_tailscale_https() {
  local cert_file key_file output_file

  cert_file="$(mktemp)"
  key_file="$(mktemp)"
  output_file="$(mktemp)"

  info "Preparing Tailscale HTTPS certificate..."
  if ! timeout 180 tailscale cert --cert-file "$cert_file" --key-file "$key_file" "$atelier_public_host" >"$output_file" 2>&1; then
    cat "$output_file" >&2
    rm -f "$cert_file" "$key_file" "$output_file"
    fail_tailscale_serve_not_enabled
  fi

  rm -f "$cert_file" "$key_file" "$output_file"
  success "Tailscale HTTPS certificate is ready"
}

pull_required_workspace_images() {
  local platform="$1" default_workspace_image

  info "Reading default workspace image from $atelier_image..."
  default_workspace_image="$(docker run --rm --platform "$platform" --entrypoint cat "$atelier_image" /app/.atelier-default-workspace-image | tr -d '\r' | head -n 1)"
  [ -n "$default_workspace_image" ] || fail "could not determine Atelier's default workspace image"

  info "Pulling required workspace image $default_workspace_image..."
  docker pull --platform "$platform" "$default_workspace_image" || fail "could not pull workspace image $default_workspace_image for $platform"
  success "Workspace image is ready"
}

pull_atelier_images() {
  local platform

  platform="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
  info "Pulling $atelier_image..."
  docker pull --platform "$platform" "$atelier_image" || fail "could not pull Atelier image $atelier_image for $platform; this release must include an image for your Docker host architecture"
  success "Atelier image is ready"

  pull_required_workspace_images "$platform"
}

prepare_installation_assets() {
  local certificate_pid images_pid certificate_status=0 images_status=0

  prepare_tailscale_https &
  certificate_pid="$!"
  pull_atelier_images &
  images_pid="$!"

  wait "$images_pid" || images_status="$?"
  if kill -0 "$certificate_pid" 2>/dev/null; then
    info "Docker image preparation finished; waiting for Tailscale HTTPS certificate..."
  fi
  wait "$certificate_pid" || certificate_status="$?"

  [ "$images_status" -eq 0 ] || return "$images_status"
  [ "$certificate_status" -eq 0 ] || return "$certificate_status"
}

verify_workspace_swap_limit() {
  local slice_cgroup="$1" swap_total_kib

  if [ -e "$slice_cgroup/memory.swap.max" ]; then
    [ "$(cat "$slice_cgroup/memory.swap.max")" = 0 ] || fail "could not disable workspace swap"
  else
    swap_total_kib="$(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo)"
    [ "$swap_total_kib" = 0 ] || fail "cgroup swap limits are unavailable but the host has swap; disable host swap or enable kernel cgroup swap accounting"
    warning "cgroup swap limits are unavailable; continuing because the host has no swap. Keep host swap disabled."
  fi
}

configure_workspace_resource_controls() {
  local slice_path slice_cgroup cgroup_driver cpu_quota cpu_period

  cgroup_driver="$(docker info --format '{{.CgroupDriver}}')"
  [ "$cgroup_driver" = systemd ] || fail "Atelier requires Docker's systemd cgroup driver (found $cgroup_driver)"

  slice_path="/etc/systemd/system/$atelier_workspace_slice"
  info "Reserving 2 GiB memory and 1 CPU from all workspace containers..."
  cat >"$slice_path" <<EOF
[Unit]
Description=Atelier workspace resource pool

[Slice]
CPUQuota=${workspace_cpu_quota}%
CPUWeight=10
IOWeight=10
MemoryMax=$workspace_memory_bytes
MemorySwapMax=0
TasksMax=32768
EOF
  systemctl daemon-reload
  systemctl start "$atelier_workspace_slice"
  slice_cgroup="/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$atelier_workspace_slice")"

  [ "$(cat "$slice_cgroup/memory.max")" = "$workspace_memory_bytes" ] || fail "could not apply the workspace memory limit"
  verify_workspace_swap_limit "$slice_cgroup"
  [ "$(cat "$slice_cgroup/pids.max")" = 32768 ] || fail "could not apply the workspace task limit"
  read -r cpu_quota cpu_period < "$slice_cgroup/cpu.max"
  [ "$cpu_quota" != max ] && [ $((100 * cpu_quota)) -eq $((workspace_cpu_quota * cpu_period)) ] || fail "could not apply the workspace CPU quota"
  success "Workspace resource pool is limited to $((workspace_memory_bytes / 1024 / 1024)) MiB and $((cpu_count - 1)) CPU(s)"
}

install_atelier() {
  local updater_ids updater_id

  mkdir -p "$atelier_data_dir"
  chown 1000:1000 "$atelier_data_dir"
  chmod 0755 "$atelier_data_dir"
  success "Data directory ready: $atelier_data_dir"

  updater_ids="$(docker ps -aq --filter "name=^/atelier-updater-")"
  if [ -n "$updater_ids" ]; then
    info "Removing stale Atelier update helpers..."
    while IFS= read -r updater_id; do
      docker rm -f "$updater_id" >/dev/null
    done <<<"$updater_ids"
    success "Stale Atelier update helpers removed"
  fi

  if docker ps -aq --filter "name=^/${atelier_name}$" | grep -q .; then
    info "Replacing existing Atelier container..."
    docker stop --time 30 "$atelier_name" >/dev/null
    docker rm "$atelier_name" >/dev/null
    success "Existing Atelier container removed"
  fi

  mkdir -p "$atelier_data_dir/docker-runtime"
  info "Starting Atelier..."
  docker run -d \
    --name "$atelier_name" \
    --label com.atelier.type=server \
    --label "com.atelier.release-channel=$atelier_channel" \
    --label "com.atelier.workspace-cgroup-parent=$atelier_workspace_slice" \
    --restart unless-stopped \
    --init \
    --privileged \
    --cpu-shares 2048 \
    --memory-reservation 1g \
    --oom-score-adj -500 \
    --network host \
    -v /var/run/docker.sock:/var/run/docker.sock \
    --mount "type=bind,src=/var/run/tailscale,dst=/var/run/tailscale" \
    --mount "type=bind,src=$atelier_data_dir,dst=/data/atelier" \
    --mount "type=bind,src=$atelier_data_dir/docker-runtime,dst=$atelier_data_dir/docker-runtime" \
    --env ATELIER_DATA_DIR=/data/atelier \
    --env "ATELIER_DOCKER_HOST_DATA_DIR=$atelier_data_dir" \
    --env "HOST=127.0.0.1" \
    --env "PORT=$atelier_port" \
    --env "ATELIER_PUBLIC_URL=https://$atelier_public_host" \
    --env ATELIER_TAILSCALE_SERVE=1 \
    "$atelier_image" >/dev/null
  success "Atelier container started"
}

show_atelier_startup_failure() {
  log "" >&2
  warning "Recent Atelier logs:" >&2
  docker logs --tail 100 "$atelier_name" >&2 || true
}

wait_for_atelier() {
  local readiness_url readiness_response deadline

  readiness_url="http://127.0.0.1:$atelier_port/up"
  deadline=$((SECONDS + 120))
  info "Waiting for Atelier to become ready..."

  while [ "$SECONDS" -lt "$deadline" ]; do
    if readiness_response="$(curl -fsS --max-time 2 "$readiness_url" 2>/dev/null)" \
      && [ "$readiness_response" = ok ] \
      && [ "$(docker inspect --format '{{.State.Running}}' "$atelier_name")" = true ]; then
      return
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$atelier_name")" != true ]; then
      show_atelier_startup_failure
      fail "Atelier exited before becoming ready"
    fi
    sleep 1
  done

  show_atelier_startup_failure
  fail "Atelier did not become ready within 120 seconds"
}

finish_installation() {
  log ""
  success "Atelier is ready"
  log "Open ${bold}https://$atelier_public_host/${reset}"
  log "Atelier will keep running in the background."
}

main() {
  parse_args "$@"

  log "${bold}Installing Atelier${reset}"
  log "Image: $atelier_image"
  log ""

  require_linux
  require_root

  if [ "$pull_only" -eq 1 ]; then
    install_docker
    start_docker
    pull_atelier_images
    success "Docker images are ready"
    return
  fi

  require_interactive_terminal
  require_supported_host
  require_tailscale
  check_ssh_latency
  install_docker
  start_docker
  configure_workspace_resource_controls
  configure_tailscale_serve
  prepare_installation_assets
  install_atelier
  wait_for_atelier
  finish_installation
}

main "$@"
