FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG NCURSES_VERSION=6.6
ARG NODE_MAJOR=22

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      locales \
      ncurses-bin \
      ncurses-term \
      ripgrep \
      fd-find \
      cmatrix \
      tmux \
      xz-utils \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# Ubuntu 24.04's ncurses database does not reliably include Ghostty's
# xterm-ghostty entry yet. Compile a newer upstream terminfo database so
# terminal apps inside tmux can use Ghostty's richer capabilities.
RUN curl -fsSL "https://ftp.gnu.org/pub/gnu/ncurses/ncurses-${NCURSES_VERSION}.tar.gz" \
  | tar -xz -C /tmp \
 && tic -x -o /usr/share/terminfo "/tmp/ncurses-${NCURSES_VERSION}/misc/terminfo.src" \
 && infocmp -x ghostty \
      | awk 'BEGIN { replaced=0 } /^#/ { print; next } replaced == 0 { print "xterm-ghostty|ghostty|Ghostty terminal emulator,"; replaced=1; next } { print }' \
      | tic -x -o /usr/share/terminfo - \
 && rm -rf "/tmp/ncurses-${NCURSES_VERSION}"

RUN set -eux; \
    node_arch="$(dpkg --print-architecture)"; \
    case "$node_arch" in \
      amd64) node_arch="x64" ;; \
      arm64) node_arch="arm64" ;; \
      armhf) node_arch="armv7l" ;; \
      ppc64el) node_arch="ppc64le" ;; \
      s390x) node_arch="s390x" ;; \
      *) echo "unsupported Node.js architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    node_dist_base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"; \
    mkdir -p /tmp/node-install; \
    curl -fsSL "$node_dist_base/SHASUMS256.txt" -o /tmp/node-install/SHASUMS256.txt; \
    node_file="$(awk -v suffix="-linux-${node_arch}.tar.xz" 'index($2, "node-v") == 1 && substr($2, length($2) - length(suffix) + 1) == suffix { print $2; exit }' /tmp/node-install/SHASUMS256.txt)"; \
    test -n "$node_file"; \
    curl -fsSL "$node_dist_base/$node_file" -o "/tmp/node-install/$node_file"; \
    awk -v file="$node_file" '$2 == file { print }' /tmp/node-install/SHASUMS256.txt > /tmp/node-install/SHASUMS256.selected; \
    (cd /tmp/node-install && sha256sum -c SHASUMS256.selected); \
    tar -xJf "/tmp/node-install/$node_file" -C /usr/local --strip-components=1; \
    rm -rf /tmp/node-install; \
    node --version; \
    npm --version

RUN curl -fsSL https://pi.dev/install.sh | sh \
 && command -v pi \
 && pi --version

RUN printf '%s\n' \
      'set -g default-terminal "xterm-ghostty"' \
      'set -as terminal-features ",xterm-ghostty:RGB"' \
      'set -g focus-events on' \
      'set -g extended-keys on' \
    > /etc/tmux.conf

RUN id -u atelier >/dev/null 2>&1 || useradd --create-home --shell /bin/bash atelier \
 && mkdir -p /.atelier /workspace \
 && chown -R atelier:atelier /.atelier /workspace

ENV TERM=xterm-ghostty \
    COLORTERM=truecolor

WORKDIR /workspace
