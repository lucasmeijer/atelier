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
      gpg \
      locales \
      python3 \
      python-is-python3 \
      cmake \
      clang \
      dotnet-sdk-8.0 \
      gcc \
      golang-go \
      ninja-build \
      ruby-full \
      ncurses-bin \
      ncurses-term \
      ripgrep \
      fd-find \
      cmatrix \
      tmux \
      xz-utils \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    bazelisk_arch="$(dpkg --print-architecture)"; \
    case "$bazelisk_arch" in \
      amd64) bazelisk_arch="amd64" ;; \
      arm64) bazelisk_arch="arm64" ;; \
      *) echo "unsupported Bazelisk architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/bazelbuild/bazelisk/releases/latest/download/bazelisk-linux-${bazelisk_arch}" -o /usr/local/bin/bazel; \
    chmod +x /usr/local/bin/bazel; \
    bazel version

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
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /etc/apt/keyrings/packages.microsoft.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends code; \
    rm -rf /var/lib/apt/lists/*; \
    code --version --no-sandbox --user-data-dir /tmp/code-version

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
      'set -g default-terminal "xterm-256color"' \
      'set -as terminal-features ",xterm-256color:RGB"' \
      'set -g focus-events on' \
      'set -g extended-keys on' \
      'set -g allow-passthrough on' \
    > /etc/tmux.conf

COPY vscode-defaults /opt/atelier/vscode-defaults
COPY bin/atelier-start-vscode /usr/local/bin/atelier-start-vscode

RUN chmod +x /usr/local/bin/atelier-start-vscode \
 && id -u atelier >/dev/null 2>&1 || useradd --create-home --shell /bin/bash atelier \
 && mkdir -p /.atelier /repos /home/atelier/.vscode-server \
 && chown -R atelier:atelier /.atelier /repos /home/atelier/.vscode-server

# `code serve-web` ships as a small CLI in the deb and downloads the actual
# web/server payload on first use. Pre-warm that cache in the image so every
# new workspace does not start with the "latest VS Code is downloading" page.
RUN set -eux; \
    su atelier -c 'ATELIER_VSCODE_HOST=127.0.0.1 nohup atelier-start-vscode > /tmp/vscode-prewarm.log 2>&1 &' ; \
    for i in $(seq 1 120); do \
      body="$(curl -fsS http://127.0.0.1:8000/ 2>/dev/null || true)"; \
      echo "$body" | grep -qi "workbench" && break; \
      sleep 1; \
      if [ "$i" = 120 ]; then cat /tmp/vscode-prewarm.log; echo "VS Code server prewarm timed out" >&2; exit 1; fi; \
    done; \
    pkill -u atelier -f 'code serve-web' || true; \
    su atelier -c '/home/atelier/.vscode/cli/serve-web/*/bin/code-server --install-extension ms-vscode.cpptools-extension-pack --force'; \
    su atelier -c '/home/atelier/.vscode/cli/serve-web/*/bin/code-server --install-extension ms-dotnettools.csharp --force'; \
    su atelier -c '/home/atelier/.vscode/cli/serve-web/*/bin/code-server --list-extensions --show-versions' | tee /tmp/vscode-extensions.log; \
    grep -x 'ms-vscode.cpptools-extension-pack@.*' /tmp/vscode-extensions.log; \
    grep -x 'ms-dotnettools.csharp@.*' /tmp/vscode-extensions.log; \
    rm -f /tmp/vscode-extensions.log; \
    rm -f /tmp/vscode-prewarm.log

ENV TERM=xterm-256color \
    COLORTERM=truecolor \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

WORKDIR /repos
