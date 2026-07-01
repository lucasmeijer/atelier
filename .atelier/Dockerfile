FROM atelier-workspace

ARG DEBIAN_FRONTEND=noninteractive

# Extra host-side tooling needed when this repository is itself used to develop
# Atelier. The default workspace image already includes Bun, Node, Playwright,
# Chromium, git/git-lfs, tmux, sqlite, compilers, Python, ripgrep/fd, etc.; this
# layer adds Docker tooling and SSH client support for `bun run web`, image build
# scripts, and release publishing from inside an Atelier workspace.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      docker.io \
      docker-buildx \
      fuse-overlayfs \
      openssh-client \
 && rm -rf /var/lib/apt/lists/*

ENV PI_CODING_AGENT_DIR=/home/atelier/.pi/agent

RUN mkdir -p /var/lib/docker /home/atelier/.pi/agent \
 && chown -R atelier:atelier /home/atelier/.pi \
 && if getent group docker >/dev/null 2>&1; then usermod -aG docker atelier; fi

WORKDIR /work
