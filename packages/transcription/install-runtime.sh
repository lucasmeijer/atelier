#!/bin/sh
set -eu

architecture="$1"
version="$2"

if ! command -v curl >/dev/null 2>&1 || [ ! -f /etc/ssl/certs/ca-certificates.crt ]; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl
fi
case "$architecture" in
  amd64) release_architecture=x86_64 ;;
  arm64) release_architecture=aarch64 ;;
  *) echo "Unsupported architecture: $architecture" >&2; exit 1 ;;
esac

archive="nemo-speech-${version}-linux-${release_architecture}-cpu.tar.gz"
release_url="https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v${version}"
cd /tmp
curl -fsSLO "$release_url/$archive"
curl -fsSLO "$release_url/$archive.sha256"
sha256sum --check "$archive.sha256"
mkdir /opt/nemo-speech
tar -xzf "$archive" --strip-components=1 -C /opt/nemo-speech
