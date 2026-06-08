#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-ghcr.io/lucasmeijer/atelier-workspace:latest}"
DOCKERFILE="$ROOT/packages/workspace-image/Dockerfile"
CONTEXT="$ROOT/packages/workspace-image"

usage() {
  cat <<EOF
Usage: $0 <build|verify|publish>

Environment:
  IMAGE  Image tag to build/publish. Default: $IMAGE

Examples:
  IMAGE=ghcr.io/<owner>/atelier-workspace:latest $0 build
  IMAGE=ghcr.io/<owner>/atelier-workspace:latest $0 verify
  IMAGE=ghcr.io/<owner>/atelier-workspace:latest $0 publish
EOF
}

build() {
  docker build -t "$IMAGE" -f "$DOCKERFILE" "$CONTEXT"
}

verify() {
  docker run --rm -i "$IMAGE" bash -s <<'VERIFY'
set -euo pipefail

test "$(id -un atelier)" = "atelier"
command -v tmux >/dev/null
command -v node >/dev/null
command -v npm >/dev/null
command -v pi >/dev/null
command -v rg >/dev/null
command -v fd >/dev/null
command -v cmatrix >/dev/null
tmux -V
node --version
npm --version
pi --version
rg --version | head -n 1
fd --version
cmatrix -V 2>&1 | head -n 1
infocmp -x xterm-ghostty >/dev/null
colors="$(TERM=xterm-ghostty tput colors)"
test "$colors" -ge 256

export TERM=xterm-ghostty COLORTERM=truecolor
rm -rf /tmp/atelier-tmux-test
mkdir -p /tmp/atelier-tmux-test
chown atelier:atelier /tmp/atelier-tmux-test

su atelier -c "tmux -S /tmp/atelier-tmux-test/socket new-session -d -s 'Terminal 1' -c /workspace 'printf \"%s %s\\n\" \"\$TERM\" \"\$COLORTERM\" > /tmp/atelier-tmux-test/pane-env; exec /bin/bash'"
su atelier -c "tmux -S /tmp/atelier-tmux-test/socket list-sessions -F '#S #{session_attached} #{session_windows}'"
test "$(su atelier -c "tmux -S /tmp/atelier-tmux-test/socket show-options -gqv extended-keys")" = "on"
su atelier -c "command -v pi >/dev/null && pi --version >/dev/null"

test "$(cat /tmp/atelier-tmux-test/pane-env)" = "xterm-ghostty truecolor"
su atelier -c "tmux -S /tmp/atelier-tmux-test/socket kill-session -t 'Terminal 1'"

echo "verified: pi, Node.js, npm, ripgrep, fd, cmatrix, tmux, extended-keys, xterm-ghostty terminfo, 256-color tput, and tmux pane TERM=xterm-ghostty"
VERIFY
}

publish() {
  build
  verify
  docker push "$IMAGE"
}

case "${1:-}" in
  build) build ;;
  verify) verify ;;
  publish) publish ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
