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
command -v python >/dev/null
command -v python3 >/dev/null
command -v cmake >/dev/null
command -v clang >/dev/null
command -v gcc >/dev/null
command -v ninja >/dev/null
command -v dotnet >/dev/null
command -v go >/dev/null
command -v bazel >/dev/null
command -v ruby >/dev/null
tmux -V
node --version
npm --version
pi --version
rg --version | head -n 1
fd --version
cmatrix -V 2>&1 | head -n 1
python --version
python3 --version
cmake --version | head -n 1
clang --version | head -n 1
gcc --version | head -n 1
ninja --version
dotnet --version
go version
bazel version | head -n 1
ruby --version
infocmp -x xterm-ghostty >/dev/null
colors="$(TERM=xterm-ghostty tput colors)"
test "$colors" -ge 256
test "${LANG:-}" = "C.UTF-8"
test "${LC_ALL:-}" = "C.UTF-8"

export TERM=xterm-ghostty COLORTERM=truecolor LANG=C.UTF-8 LC_ALL=C.UTF-8
rm -rf /tmp/atelier-tmux-test
mkdir -p /tmp/atelier-tmux-test
chown atelier:atelier /tmp/atelier-tmux-test

su atelier -c "tmux -S /tmp/atelier-tmux-test/socket new-session -d -s 'Terminal 1' -c /repos 'printf \"%s %s\\n\" \"\$TERM\" \"\$COLORTERM\" > /tmp/atelier-tmux-test/pane-env; exec /bin/bash'"
su atelier -c "tmux -S /tmp/atelier-tmux-test/socket list-sessions -F '#S #{session_attached} #{session_windows}'"
test "$(su atelier -c "tmux -S /tmp/atelier-tmux-test/socket show-options -gqv extended-keys")" = "on"
su atelier -c "command -v pi >/dev/null && pi --version >/dev/null"

test "$(cat /tmp/atelier-tmux-test/pane-env)" = "xterm-ghostty truecolor"
su atelier -c "tmux -S /tmp/atelier-tmux-test/socket kill-session -t 'Terminal 1'"

echo "verified: pi, Node.js, npm, ripgrep, fd, cmatrix, tmux, Python, CMake, Clang, GCC, Ninja, .NET SDK, Go, Bazel, Ruby, UTF-8 locale, extended-keys, xterm-ghostty terminfo, 256-color tput, and tmux pane TERM=xterm-ghostty"
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
