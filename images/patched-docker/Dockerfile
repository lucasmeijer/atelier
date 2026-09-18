# syntax=docker/dockerfile:1
# Shared base for workspace and service daemons. Neither Atelier nor workspace
# policy belongs here. Build from this directory with ./build.sh --load.
FROM docker:29.6.1-dind@sha256:66d292e5c26bd33a6f6f61cacb880de2186339a524ecba1ce098dbbaceed6515 AS docker-tools
FROM ubuntu:26.04@sha256:513c074113a871b51a8d16ab445c88779d6452d937a164fb5cc479f32668a41d AS ubuntu

# Compile natively, including CGO/seccomp, even when targeting the other CPU.
FROM --platform=$BUILDPLATFORM golang:1.26.0@sha256:fb612b7831d53a89cbc0aaa7855b69ad7b0caf603715860cf538df854d047b84 AS build
ARG TARGETARCH
RUN dpkg --add-architecture "$TARGETARCH" \
    && apt-get update && apt-get install -y --no-install-recommends \
      libseccomp-dev libseccomp-dev:${TARGETARCH} libc6-dev:${TARGETARCH} pkg-config \
      gcc-aarch64-linux-gnu gcc-x86-64-linux-gnu \
    && rm -rf /var/lib/apt/lists/*
# Parent of Moby PR #53126: pin the source, then apply both reviewable patches.
ADD --checksum=sha256:60063d5e609c498333bad7a2c0c4be43abe417aabdaacac0137f6ef4519f357a \
    https://codeload.github.com/moby/moby/tar.gz/0584603b8c3a7ad224a2932ccdab0d17d6202687 /tmp/moby.tar.gz
WORKDIR /src
RUN tar xzf /tmp/moby.tar.gz --strip-components=1 && rm /tmp/moby.tar.gz
COPY patches/ /patches/
RUN git apply /patches/0001-moby-mount-manager.patch \
    && git apply /patches/0002-buildkit-erofs.patch
RUN --mount=type=cache,id=patched-docker-go-${TARGETARCH},target=/root/.cache/go-build \
    /usr/local/go/bin/go test -mod=vendor \
      github.com/moby/buildkit/snapshot \
      github.com/moby/buildkit/exporter/containerimage \
      -run 'TestManagedMount|TestFetchOnly' -count=1 \
    && case "$TARGETARCH" in \
         arm64) compiler=aarch64-linux-gnu ;; \
         amd64) compiler=x86_64-linux-gnu ;; \
         *) exit 1 ;; \
       esac \
    && CGO_ENABLED=1 GOOS=linux GOARCH="$TARGETARCH" CC="${compiler}-gcc" \
      PKG_CONFIG_LIBDIR="/usr/lib/${compiler}/pkgconfig" \
      /usr/local/go/bin/go build -mod=vendor -trimpath \
      -tags 'seccomp exclude_graphdriver_btrfs' \
      -ldflags '-X github.com/moby/moby/v2/dockerversion.Version=atelier-erofs-1 -X github.com/moby/moby/v2/dockerversion.GitCommit=0584603+atelier-erofs' \
      -o /out/dockerd ./cmd/dockerd \
    && /usr/local/go/bin/go version -m /out/dockerd > /out/build-info.txt

# The transfer helper uses the same containerd release as the runtime below.
FROM --platform=$BUILDPLATFORM golang:1.26.0@sha256:fb612b7831d53a89cbc0aaa7855b69ad7b0caf603715860cf538df854d047b84 AS image-transfer
WORKDIR /src
COPY image-transfer/go.mod image-transfer/go.sum ./
RUN GOTOOLCHAIN=go1.26.8 go mod download
COPY image-transfer/*.go ./
ARG TARGETARCH
RUN --mount=type=cache,id=atelier-image-transfer-go,target=/root/.cache/go-build \
    GOTOOLCHAIN=go1.26.8 go test ./... \
    && GOTOOLCHAIN=go1.26.8 CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -trimpath -o /out/atelier-image-transfer .

# Patch ctr cache leases and the daemon's empty-mount EROFS differ dispatch.
# Keep the shims from the matching upstream release.
FROM --platform=$BUILDPLATFORM golang:1.26.0@sha256:fb612b7831d53a89cbc0aaa7855b69ad7b0caf603715860cf538df854d047b84 AS containerd-patched
ADD --checksum=sha256:110aba8239bedd0efc7d359fa211b7ed1634713c3c05da3dd43a5b33d4a40194 \
    https://codeload.github.com/containerd/containerd/tar.gz/58e6cee9dee67ee87ee2f727d3570009050f9954 /tmp/containerd.tar.gz
WORKDIR /src
RUN tar xzf /tmp/containerd.tar.gz --strip-components=1 && rm /tmp/containerd.tar.gz
COPY patches/0003-containerd-erofs-cache-lease.patch /tmp/lease.patch
COPY patches/0004-containerd-erofs-empty-mounts.patch /tmp/empty-mounts.patch
COPY patches/0005-containerd-erofs-cache-reuse.patch /tmp/cache-reuse.patch
COPY patches/0006-containerd-loop-device-node.patch /tmp/loop-device-node.patch
RUN git apply /tmp/lease.patch /tmp/empty-mounts.patch /tmp/cache-reuse.patch /tmp/loop-device-node.patch
ARG TARGETARCH
RUN --mount=type=cache,id=atelier-ctr-go,target=/root/.cache/go-build \
    GOTOOLCHAIN=go1.26.8 go test -mod=vendor ./internal/erofsutils \
    && GOTOOLCHAIN=go1.26.8 CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -mod=vendor -trimpath \
      -ldflags '-X github.com/containerd/containerd/v2/version.Version=v2.4.0-beta.0-atelier -X github.com/containerd/containerd/v2/version.Revision=58e6cee9dee67ee87ee2f727d3570009050f9954+cache-lease+mount-root+cache-reuse+loop-node' \
      -o /out/ ./cmd/ctr ./cmd/containerd

FROM --platform=$BUILDPLATFORM ubuntu:26.04@sha256:513c074113a871b51a8d16ab445c88779d6452d937a164fb5cc479f32668a41d AS containerd
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
COPY containerd.sha256 /tmp/containerd.sha256
RUN cd /tmp \
    && curl -fSL -o containerd-2.4.0-beta.0-linux-${TARGETARCH}.tar.gz \
      https://github.com/containerd/containerd/releases/download/v2.4.0-beta.0/containerd-2.4.0-beta.0-linux-${TARGETARCH}.tar.gz \
    && grep " containerd-2.4.0-beta.0-linux-${TARGETARCH}.tar.gz$" containerd.sha256 | sha256sum -c - \
    && mkdir /out && tar xzf containerd-2.4.0-beta.0-linux-${TARGETARCH}.tar.gz -C /out

FROM ubuntu AS runtime
LABEL org.opencontainers.image.source="https://github.com/lucasmeijer/atelier" \
      org.opencontainers.image.title="Atelier Docker runtime" \
      org.opencontainers.image.description="Ubuntu-based Docker runtime with patched embedded BuildKit and containerd EROFS shared-cache support."
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates erofs-utils iproute2 iptables libseccomp2 runc tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/erofs-cache /data/docker /data/containerd /etc/docker /etc/containerd
COPY --from=docker-tools /usr/local/bin/docker /usr/local/bin/docker-init /usr/local/bin/docker-proxy /usr/local/bin/
COPY --from=docker-tools /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
COPY --from=containerd /out/bin/ /usr/local/bin/
COPY --from=containerd-patched /out/ /usr/local/bin/
COPY --from=build /out/dockerd /usr/local/bin/dockerd
COPY --from=image-transfer /out/atelier-image-transfer /usr/local/bin/atelier-image-transfer
COPY --from=build /src/LICENSE /src/NOTICE /usr/share/atelier-patched-docker/
COPY --from=build /out/build-info.txt /usr/share/atelier-patched-docker/build-info.txt
COPY patches/ /usr/share/atelier-patched-docker/patches/
COPY containerd.toml /etc/containerd/config.toml
COPY daemon.json /etc/docker/daemon.json
COPY --chmod=755 entrypoint.sh /usr/local/bin/atelier-dockerd
# Both daemon stores live under this one explicitly mounted volume. No VOLUME
# instruction: derived images choose their storage and do not inherit anonymous volumes.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/atelier-dockerd"]
CMD ["dockerd"]
