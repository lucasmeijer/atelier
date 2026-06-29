#!/usr/bin/env bash
set -euo pipefail

atelier_image="ghcr.io/lucasmeijer/atelier:stable"
atelier_name="atelier"
atelier_data_dir="/var/lib/atelier"
atelier_port="80"

if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ -n "${TERM:-}" ]; then
  green="$(tput setaf 2)"
  blue="$(tput setaf 4)"
  bold="$(tput bold)"
  reset="$(tput sgr0)"
else
  green=""
  blue=""
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

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_linux() {
  [ "$(uname -s)" = "Linux" ] || fail "this installer only supports Linux"
  success "Linux detected"
}

require_root() {
  [ "${EUID:-$(id -u)}" -eq 0 ] || fail "run this installer as root, for example: curl -fsSL https://lucasmeijer.com/get-atelier | sudo bash"
  success "Running as root"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
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
  command_exists tailscale || fail "Tailscale is required. Install it, run 'tailscale up', then rerun this installer."
  tailscale status >/dev/null || fail "Tailscale is not up. Run 'tailscale up', then rerun this installer."

  tailscale_ip="$(tailscale ip -4 | head -n 1)"
  [ -n "$tailscale_ip" ] || fail "could not determine this machine's Tailscale IPv4 address"
  tailscale_dns="$(tailscale status --json | sed -n 's/.*"DNSName": "\([^"]*\)".*/\1/p' | head -n 1 | sed 's/\.$//')"
  atelier_public_host="${tailscale_dns:-$tailscale_ip}"

  success "Tailscale is up: $atelier_public_host"
}

install_atelier() {
  mkdir -p "$atelier_data_dir"
  chown 1000:1000 "$atelier_data_dir"
  chmod 0755 "$atelier_data_dir"
  success "Data directory ready: $atelier_data_dir"

  info "Pulling $atelier_image..."
  docker pull "$atelier_image"
  success "Atelier image is ready"

  if docker ps -aq --filter "name=^/${atelier_name}$" | grep -q .; then
    info "Replacing existing Atelier container..."
    docker rm -f "$atelier_name" >/dev/null
    success "Existing Atelier container removed"
  fi

  info "Starting Atelier..."
  docker run -d \
    --name "$atelier_name" \
    --label com.atelier.type=server \
    --restart unless-stopped \
    --init \
    --network host \
    -v /var/run/docker.sock:/var/run/docker.sock \
    --mount "type=bind,src=$atelier_data_dir,dst=/data/atelier" \
    --env ATELIER_DATA_DIR=/data/atelier \
    --env "ATELIER_DOCKER_HOST_DATA_DIR=$atelier_data_dir" \
    --env "HOST=$tailscale_ip" \
    --env "PORT=$atelier_port" \
    --env "ATELIER_PUBLIC_URL=http://$atelier_public_host" \
    "$atelier_image" >/dev/null
  success "Atelier container started"
}

main() {
  log "${bold}Installing Atelier${reset}"
  log ""

  require_linux
  require_root
  install_docker
  start_docker
  require_tailscale
  install_atelier

  log ""
  log "${bold}Atelier is starting. Following logs now.${reset}"
  log "Press Ctrl-C to stop watching logs; Atelier will keep running."
  log ""
  docker logs -f "$atelier_name"
}

main "$@"
