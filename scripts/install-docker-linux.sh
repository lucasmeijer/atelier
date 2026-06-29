#!/usr/bin/env bash
set -euo pipefail

atelier_image="ghcr.io/lucasmeijer/atelier:latest"
atelier_name="atelier"
atelier_data_dir="/var/lib/atelier"
atelier_port="80"

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_linux() {
  [ "$(uname -s)" = "Linux" ] || fail "this installer only supports Linux"
}

require_root() {
  [ "${EUID:-$(id -u)}" -eq 0 ] || fail "run this installer as root, for example: curl -fsSL <url> | sudo bash"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

install_docker() {
  if command_exists docker; then
    return
  fi

  log "Docker is not installed; installing Docker..."

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
}

start_docker() {
  if command_exists systemctl; then
    systemctl enable --now docker
  elif command_exists service; then
    service docker start
  else
    fail "could not start Docker; systemctl/service is unavailable"
  fi

  docker info >/dev/null
}

require_tailscale() {
  command_exists tailscale || fail "Tailscale is required. Install it, run 'tailscale up', then rerun this installer."
  tailscale status >/dev/null || fail "Tailscale is not up. Run 'tailscale up', then rerun this installer."

  tailscale_ip="$(tailscale ip -4 | head -n 1)"
  [ -n "$tailscale_ip" ] || fail "could not determine this machine's Tailscale IPv4 address"
}

install_atelier() {
  install -d -o 1000 -g 1000 -m 0755 "$atelier_data_dir"

  log "Pulling $atelier_image..."
  docker pull "$atelier_image"

  if docker ps -aq --filter "name=^/${atelier_name}$" | grep -q .; then
    log "Replacing existing Atelier container..."
    docker rm -f "$atelier_name" >/dev/null
  fi

  log "Starting Atelier..."
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
    "$atelier_image" >/dev/null
}

main() {
  require_linux
  require_root
  install_docker
  start_docker
  require_tailscale
  install_atelier

  log ""
  log "Atelier is starting. Following logs now."
  log "Press Ctrl-C to stop watching logs; Atelier will keep running."
  log ""
  docker logs -f "$atelier_name"
}

main "$@"
