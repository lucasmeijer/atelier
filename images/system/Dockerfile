ARG RUNTIME_IMAGE=ghcr.io/lucasmeijer/atelier-docker@sha256:7508a6c8e8b54632da8d2ca4a561fb2ee2dd48b223d29254b45a8a1ea5b067b0
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM ghcr.io/tailscale/tailscale:v1.102.3@sha256:8c42c4574ab066384fcb72f69e086a2ff1dd3652eb6f56856cee34bcf0d2f680 AS tailscale
FROM ${RUNTIME_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends nftables && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.source="https://github.com/lucasmeijer/atelier" \
      org.opencontainers.image.title="Atelier System"
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY .build/supervisor.js .build/client.js .build/design-system.css /opt/atelier-system/
ENTRYPOINT ["/usr/bin/tini", "--", "bun", "/opt/atelier-system/supervisor.js"]
CMD []
