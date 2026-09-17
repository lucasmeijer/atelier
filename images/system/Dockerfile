ARG RUNTIME_IMAGE=ghcr.io/lucasmeijer/atelier-docker@sha256:a33d63b172fc0bff29da1e01981866a9f53db19001c6514ce905c59c1c71e4b0
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun
FROM ghcr.io/tailscale/tailscale:v1.102.3@sha256:8c42c4574ab066384fcb72f69e086a2ff1dd3652eb6f56856cee34bcf0d2f680 AS tailscale
FROM ${RUNTIME_IMAGE}
# Keep incident-response tools in the System image, not the shared Docker runtime.
# Profiling needs host kernel support/permissions; installing systemd only supplies
# its diagnostic commands (the container still runs the Atelier supervisor).
RUN apt-get update && apt-get install -y --no-install-recommends \
    atop bpfcc-tools bpftrace btop coreutils dnsutils htop iftop \
    iotop-c iproute2 iputils-ping linux-perf lsof mtr-tiny ncdu nethogs \
    nftables procps psmisc smem strace sysstat systemd tcpdump tmux util-linux \
    && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.source="https://github.com/lucasmeijer/atelier" \
      org.opencontainers.image.title="Atelier System"
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY .build/supervisor.js .build/client.js .build/design-system.css /opt/atelier-system/
ENTRYPOINT ["/usr/bin/tini", "--", "bun", "/opt/atelier-system/supervisor.js"]
CMD []
