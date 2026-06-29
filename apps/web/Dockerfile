# syntax=docker/dockerfile:1

FROM docker:29-cli AS docker-cli
FROM oven/bun:1.3.14 AS bun-dist

FROM ubuntu:26.04 AS deps
ARG DEBIAN_FRONTEND=noninteractive
COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/projects/package.json packages/projects/package.json
COPY packages/workspace/package.json packages/workspace/package.json
COPY packages/workspace-image/package.json packages/workspace-image/package.json
COPY packages/workspace-terminal/package.json packages/workspace-terminal/package.json
COPY packages/observable-terminal/package.json packages/observable-terminal/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/browser/package.json packages/browser/package.json
COPY packages/desktop/package.json packages/desktop/package.json
COPY packages/keypress-probe/package.json packages/keypress-probe/package.json
COPY packages/vscode/package.json packages/vscode/package.json
COPY packages/proxy-egress/package.json packages/proxy-egress/package.json
COPY packages/proxy-ingress/package.json packages/proxy-ingress/package.json
COPY packages/update/package.json packages/update/package.json

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run --cwd apps/web build:client
RUN bun run check

FROM ubuntu:26.04 AS runtime
ARG DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      git-lfs \
      gosu \
      libcap2-bin \
      openssh-client \
      tmux \
 && rm -rf /var/lib/apt/lists/*

COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx
RUN setcap cap_net_bind_service=+ep /usr/local/bin/bun
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

ARG ATELIER_COMMIT_ID
ARG ATELIER_COMMIT_DESCRIPTION
ARG ATELIER_DEFAULT_WORKSPACE_IMAGE
ARG ATELIER_IMAGE_CREATED
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV ATELIER_COMMIT_ID=${ATELIER_COMMIT_ID}
ENV ATELIER_COMMIT_DESCRIPTION=${ATELIER_COMMIT_DESCRIPTION}
ENV ATELIER_NAMESPACE=default
LABEL org.opencontainers.image.source="https://github.com/lucasmeijer/atelier" \
      org.opencontainers.image.revision="${ATELIER_COMMIT_ID}" \
      org.opencontainers.image.created="${ATELIER_IMAGE_CREATED}"

COPY --from=build /app /app
RUN printf '%s\n' "$ATELIER_DEFAULT_WORKSPACE_IMAGE" > /app/.atelier-default-workspace-image
RUN printf '%s\n' '#!/usr/bin/env sh' 'exec bun /app/packages/update/src/server/update-helper.ts "$@"' > /usr/local/bin/atelier-update-helper \
 && chmod 755 /usr/local/bin/atelier-update-helper /app/apps/web/docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/apps/web/docker-entrypoint.sh"]
CMD ["bun", "run", "apps/web/src/server/main.ts"]
