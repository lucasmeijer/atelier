FROM atelier-workspace

ARG DEBIAN_FRONTEND=noninteractive

# Extra host-side tooling needed when this repository is itself used to develop
# Atelier. The default workspace image already includes Bun, Node, Docker,
# Playwright, Chromium, git/git-lfs, tmux, sqlite, compilers, Python,
# ripgrep/fd, etc.; this layer adds SSH client support for image builds and
# release publishing from inside an Atelier workspace.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*

ENV PI_CODING_AGENT_DIR=/home/atelier/.pi/agent

RUN mkdir -p /home/atelier/.pi/agent \
 && chown -R atelier:atelier /home/atelier/.pi

WORKDIR /work
