#!/usr/bin/env bash
set -euo pipefail

atelier_repository="ghcr.io/lucasmeijer/atelier"
atelier_channel="stable"
atelier_image=""
atelier_name="atelier"
atelier_data_dir="/var/lib/atelier"
atelier_port="80"

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

  if [ -n "${SSH_CONNECTION:-}" ] && command_exists ss; then
    set -- $SSH_CONNECTION
    ss -tin "src $3:$4 dst $1:$2" >"$latency_output" 2>&1
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

require_tailscale() {
  local status_json

  command_exists tailscale || fail "Tailscale is required. Install it, run 'tailscale up', then rerun this installer."
  tailscale status >/dev/null || fail "Tailscale is not up. Run 'tailscale up', then rerun this installer."

  tailscale_ip="$(tailscale ip -4 | head -n 1)"
  [ -n "$tailscale_ip" ] || fail "could not determine this machine's Tailscale IPv4 address"

  status_json="$(mktemp)"
  tailscale status --json >"$status_json"

  tailscale_dns="$(sed -n 's/.*"DNSName": "\([^"]*\)".*/\1/p' "$status_json" | head -n 1 | sed 's/\.$//')"
  [ -n "$tailscale_dns" ] || fail_tailscale_serve_not_enabled
  atelier_public_host="$tailscale_dns"

  grep -Fq '"https"' "$status_json" || fail_tailscale_serve_not_enabled
  grep -Fq "\"$atelier_public_host\"" "$status_json" || fail_tailscale_serve_not_enabled

  rm -f "$status_json"
  success "Tailscale is up: $atelier_public_host"
}

configure_tailscale_serve() {
  local config_file output_file port

  command_exists curl || fail "curl is required to configure Tailscale Serve"
  [ -S /var/run/tailscale/tailscaled.sock ] || fail "tailscaled local API socket not found"

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
  success "Tailscale Serve is ready: https://$atelier_public_host/"
}

pull_required_workspace_images() {
  local default_workspace_image

  info "Reading default workspace image from $atelier_image..."
  default_workspace_image="$(docker run --rm --entrypoint cat "$atelier_image" /app/.atelier-default-workspace-image | tr -d '\r' | head -n 1)"
  [ -n "$default_workspace_image" ] || fail "could not determine Atelier's default workspace image"

  info "Pulling workspace image $default_workspace_image..."
  docker pull "$default_workspace_image"
  success "Workspace image is ready"
}

install_atelier() {
  mkdir -p "$atelier_data_dir"
  chown 1000:1000 "$atelier_data_dir"
  chmod 0755 "$atelier_data_dir"
  success "Data directory ready: $atelier_data_dir"

  info "Pulling $atelier_image..."
  docker pull "$atelier_image"
  success "Atelier image is ready"

  pull_required_workspace_images

  if docker ps -aq --filter "name=^/atelier-updater-" | grep -q .; then
    info "Removing stale Atelier update helpers..."
    docker rm -f $(docker ps -aq --filter "name=^/atelier-updater-") >/dev/null
    success "Stale Atelier update helpers removed"
  fi

  if docker ps -aq --filter "name=^/${atelier_name}$" | grep -q .; then
    info "Replacing existing Atelier container..."
    docker rm -f "$atelier_name" >/dev/null
    success "Existing Atelier container removed"
  fi

  info "Starting Atelier..."
  docker run -d \
    --name "$atelier_name" \
    --label com.atelier.type=server \
    --label "com.atelier.release-channel=$atelier_channel" \
    --restart unless-stopped \
    --init \
    --network host \
    -v /var/run/docker.sock:/var/run/docker.sock \
    --mount "type=bind,src=/var/run/tailscale,dst=/var/run/tailscale" \
    --mount "type=bind,src=$atelier_data_dir,dst=/data/atelier" \
    --env ATELIER_DATA_DIR=/data/atelier \
    --env "ATELIER_DOCKER_HOST_DATA_DIR=$atelier_data_dir" \
    --env "HOST=127.0.0.1" \
    --env "PORT=$atelier_port" \
    --env "ATELIER_PUBLIC_URL=https://$atelier_public_host" \
    --env ATELIER_TAILSCALE_SERVE=1 \
    "$atelier_image" >/dev/null
  success "Atelier container started"
}

main() {
  parse_args "$@"

  log "${bold}Installing Atelier${reset}"
  log "Image: $atelier_image"
  log ""

  require_linux
  require_root
  check_ssh_latency
  install_docker
  start_docker
  require_tailscale
  configure_tailscale_serve
  install_atelier

  log ""
  log "${bold}Atelier is starting. Following logs now.${reset}"
  log "Press Ctrl-C to stop watching logs; Atelier will keep running."
  log ""
  docker logs -f "$atelier_name"
}

main "$@"
