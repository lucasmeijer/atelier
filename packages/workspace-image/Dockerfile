FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG NCURSES_VERSION=6.6

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      locales \
      ncurses-bin \
      ncurses-term \
      tmux \
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

RUN printf '%s\n' \
      'set -g default-terminal "xterm-ghostty"' \
      'set -as terminal-features ",xterm-ghostty:RGB"' \
      'set -g focus-events on' \
    > /etc/tmux.conf

RUN id -u atelier >/dev/null 2>&1 || useradd --create-home --shell /bin/bash atelier \
 && mkdir -p /.atelier /workspace \
 && chown -R atelier:atelier /.atelier /workspace

ENV TERM=xterm-ghostty \
    COLORTERM=truecolor

WORKDIR /workspace
