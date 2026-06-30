FROM atelier-workspace

ARG DEBIAN_FRONTEND=noninteractive

# Extra host-side tooling needed when this repository is itself used to develop
# Atelier. The default workspace image already includes Bun, Node, Playwright,
# Chromium, git/git-lfs, tmux, sqlite, compilers, Python, ripgrep/fd, etc.; this
# layer adds the Docker tooling and SSH client that `bun run web` and the image
# build scripts shell out to.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      docker.io \
      openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Warm Bun's install cache for this monorepo so a fresh Atelier workspace can run
# `bun install --frozen-lockfile` quickly even though /work is bind-mounted at
# runtime and cannot reuse an image-baked node_modules directory.
RUN install -d -o atelier -g atelier /tmp/atelier-deps /home/atelier/.bun
WORKDIR /tmp/atelier-deps
COPY --chown=atelier:atelier package.json bun.lock bunfig.toml tsconfig.json ./
COPY --chown=atelier:atelier apps/web/package.json apps/web/package.json
COPY --chown=atelier:atelier packages/core/package.json packages/core/package.json
COPY --chown=atelier:atelier packages/agent/package.json packages/agent/package.json
COPY --chown=atelier:atelier packages/projects/package.json packages/projects/package.json
COPY --chown=atelier:atelier packages/workspace/package.json packages/workspace/package.json
COPY --chown=atelier:atelier packages/workspace-image/package.json packages/workspace-image/package.json
COPY --chown=atelier:atelier packages/workspace-terminal/package.json packages/workspace-terminal/package.json
COPY --chown=atelier:atelier packages/observable-terminal/package.json packages/observable-terminal/package.json
COPY --chown=atelier:atelier packages/shared/package.json packages/shared/package.json
COPY --chown=atelier:atelier packages/browser/package.json packages/browser/package.json
COPY --chown=atelier:atelier packages/desktop/package.json packages/desktop/package.json
COPY --chown=atelier:atelier packages/keypress-probe/package.json packages/keypress-probe/package.json
COPY --chown=atelier:atelier packages/vscode/package.json packages/vscode/package.json
COPY --chown=atelier:atelier packages/proxy-egress/package.json packages/proxy-egress/package.json
COPY --chown=atelier:atelier packages/proxy-ingress/package.json packages/proxy-ingress/package.json
COPY --chown=atelier:atelier packages/update/package.json packages/update/package.json
RUN chown -R atelier:atelier /tmp/atelier-deps /home/atelier/.bun \
 && su atelier -c 'cd /tmp/atelier-deps && bun install --frozen-lockfile' \
 && rm -rf /tmp/atelier-deps/node_modules

WORKDIR /work
