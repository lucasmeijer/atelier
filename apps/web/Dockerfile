FROM docker:29-cli AS docker-cli
FROM oven/bun:1.4.0 AS bun-dist

FROM ubuntu:26.04 AS transcription-runtime
ARG TARGETARCH
ARG NEMO_SPEECH_VERSION=0.1.0
COPY packages/transcription/install-runtime.sh /tmp/install-transcription-runtime.sh
RUN sh /tmp/install-transcription-runtime.sh "$TARGETARCH" "$NEMO_SPEECH_VERSION"

FROM ubuntu:26.04 AS deps
ARG DEBIAN_FRONTEND=noninteractive
COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/design-system/package.json packages/design-system/package.json
COPY packages/files/package.json packages/files/package.json
COPY packages/markdown/package.json packages/markdown/package.json
COPY packages/projects/package.json packages/projects/package.json
COPY packages/workspace/package.json packages/workspace/package.json
COPY packages/workspace-image/package.json packages/workspace-image/package.json
COPY packages/workspace-terminal/package.json packages/workspace-terminal/package.json
COPY packages/observable-terminal/package.json packages/observable-terminal/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/browser/package.json packages/browser/package.json
COPY packages/keypress-probe/package.json packages/keypress-probe/package.json
COPY packages/vscode/package.json packages/vscode/package.json
COPY packages/proxy-egress/package.json packages/proxy-egress/package.json
COPY packages/proxy-ingress/package.json packages/proxy-ingress/package.json
COPY packages/review/package.json packages/review/package.json
COPY packages/subagents/package.json packages/subagents/package.json
COPY packages/syntax/package.json packages/syntax/package.json
COPY packages/transcription/package.json packages/transcription/package.json
COPY packages/update/package.json packages/update/package.json

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run --cwd apps/web build:client

FROM ubuntu:26.04 AS runtime
ARG DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      git-lfs \
      gosu \
      libcap2-bin \
      openssh-client \
      sudo \
      tmux

COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx
RUN setcap cap_net_bind_service=+ep /usr/local/bin/bun
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
COPY --from=transcription-runtime /opt/nemo-speech /opt/nemo-speech
RUN ln -s /opt/nemo-speech/bin/nemo-speech /usr/local/bin/nemo-speech

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV ATELIER_NAMESPACE=default

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build --exclude=node_modules /app /app
RUN printf '%s\n' '#!/usr/bin/env sh' 'exec bun /app/packages/update/src/server/update-helper.ts "$@"' > /usr/local/bin/atelier-update-helper \
 && printf '%s\n' '#!/usr/bin/env sh' 'exec /usr/local/bin/bun /app/packages/proxy-ingress/src/ingress/tailscale-serve-helper.ts "$@"' > /usr/local/bin/atelier-tailscale-serve-helper \
 && chmod 755 /usr/local/bin/atelier-update-helper /usr/local/bin/atelier-tailscale-serve-helper /app/apps/web/docker-entrypoint.sh

ARG ATELIER_COMMIT_ID
ARG ATELIER_COMMIT_DESCRIPTION
ARG ATELIER_DEFAULT_WORKSPACE_IMAGE
ARG ATELIER_SELF_UPDATE_COMPATIBILITY
ENV ATELIER_COMMIT_ID=${ATELIER_COMMIT_ID}
ENV ATELIER_COMMIT_DESCRIPTION=${ATELIER_COMMIT_DESCRIPTION}
LABEL org.opencontainers.image.source="https://github.com/lucasmeijer/atelier" \
      org.opencontainers.image.revision="${ATELIER_COMMIT_ID}" \
      com.atelier.self-update-compatibility="${ATELIER_SELF_UPDATE_COMPATIBILITY}"
RUN printf '%s\n' "$ATELIER_DEFAULT_WORKSPACE_IMAGE" > /app/.atelier-default-workspace-image

EXPOSE 3000

ENTRYPOINT ["/app/apps/web/docker-entrypoint.sh"]
CMD ["bun", "run", "apps/web/src/server/main.ts"]
