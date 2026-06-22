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
COPY packages/repository/package.json packages/repository/package.json
COPY packages/workspace/package.json packages/workspace/package.json
COPY packages/workspace-image/package.json packages/workspace-image/package.json
COPY packages/workspace-terminal/package.json packages/workspace-terminal/package.json
COPY packages/observable-terminal/package.json packages/observable-terminal/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/browser/package.json packages/browser/package.json
COPY packages/desktop/package.json packages/desktop/package.json
COPY packages/keypress-probe/package.json packages/keypress-probe/package.json
COPY packages/vscode/package.json packages/vscode/package.json
COPY packages/workspace-proxy/package.json packages/workspace-proxy/package.json

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
      openssh-client \
      tmux \
 && rm -rf /var/lib/apt/lists/*

COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

ARG ATELIER_COMMIT_ID
ARG ATELIER_COMMIT_DESCRIPTION
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV ATELIER_COMMIT_ID=${ATELIER_COMMIT_ID}
ENV ATELIER_COMMIT_DESCRIPTION=${ATELIER_COMMIT_DESCRIPTION}

COPY --from=build /app /app

EXPOSE 3000

CMD ["bun", "run", "apps/web/src/server/main.ts"]
