# syntax=docker/dockerfile:1

FROM docker:29-cli AS docker-cli

FROM oven/bun:1.3.14-debian AS deps
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/pi-config/package.json packages/pi-config/package.json
COPY packages/terminal/package.json packages/terminal/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY tools/atelier/package.json tools/atelier/package.json

RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run --cwd apps/web build:client
RUN bun run check

FROM oven/bun:1.3.14-debian AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      openssh-client \
 && rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV ATELIER_AGENT_FAKE=0

COPY --from=build /app /app

EXPOSE 3000

CMD ["bun", "run", "apps/web/src/server/main.ts"]
