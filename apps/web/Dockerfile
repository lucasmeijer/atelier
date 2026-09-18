ARG ATELIER_RUNTIME_IMAGE=ghcr.io/lucasmeijer/atelier-docker@sha256:978097dea150b4e9c4a17b82ca9422337eb2d68a98bfa7503c1e8c842eb31fba
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

COPY . .

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

FROM deps AS build
RUN bun run --cwd apps/web build:client

FROM ${ATELIER_RUNTIME_IMAGE} AS runtime
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
      socat \
      util-linux \
      tmux

COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx
RUN setcap cap_net_bind_service=+ep /usr/local/bin/bun
COPY --from=transcription-runtime /opt/nemo-speech /opt/nemo-speech
RUN ln -s /opt/nemo-speech/bin/nemo-speech /usr/local/bin/nemo-speech

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV ATELIER_NAMESPACE=default
ENV ATELIER_DATA_DIR=/data/app

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build --exclude=node_modules /app /app
RUN printf '%s\n' '#!/usr/bin/env sh' 'exec /usr/local/bin/bun /app/packages/proxy-ingress/src/ingress/tailscale-serve-helper.ts "$@"' > /usr/local/bin/atelier-tailscale-serve-helper \
 && chmod 755 /usr/local/bin/atelier-tailscale-serve-helper /app/apps/web/docker-entrypoint.sh

ARG ATELIER_COMMIT_ID
ARG ATELIER_COMMIT_DESCRIPTION
ARG ATELIER_DEFAULT_WORKSPACE_IMAGE
ARG ATELIER_EAGERLY_PRELOAD="[]"
ENV ATELIER_COMMIT_ID=${ATELIER_COMMIT_ID}
ENV ATELIER_COMMIT_DESCRIPTION=${ATELIER_COMMIT_DESCRIPTION}
LABEL org.opencontainers.image.source="https://github.com/lucasmeijer/atelier" \
      org.opencontainers.image.revision="${ATELIER_COMMIT_ID}" \
      eagerly-preload="${ATELIER_EAGERLY_PRELOAD}"
RUN printf '%s\n' "$ATELIER_DEFAULT_WORKSPACE_IMAGE" > /app/.atelier-default-workspace-image

EXPOSE 3000

ENTRYPOINT ["/app/apps/web/docker-entrypoint.sh"]
CMD ["bun", "run", "apps/web/src/server/main.ts"]
