FROM atelier-workspace

ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH
ARG NEMO_SPEECH_VERSION=0.1.0

# Atelier's transcription service runs in this development workspace when the
# web server is launched from source. The production server image installs the
# same runtime in apps/web/Dockerfile.
COPY packages/transcription/install-runtime.sh /tmp/install-transcription-runtime.sh
RUN sh /tmp/install-transcription-runtime.sh "$TARGETARCH" "$NEMO_SPEECH_VERSION" \
 && ln -s /opt/nemo-speech/bin/nemo-speech /usr/local/bin/nemo-speech \
 && rm -f /tmp/install-transcription-runtime.sh /tmp/nemo-speech-*.tar.gz /tmp/nemo-speech-*.tar.gz.sha256 \
 && rm -rf /var/lib/apt/lists/*

# Extra host-side tooling needed when this repository is itself used to develop
# Atelier. The default workspace image already includes Bun, Node, Docker,
# Playwright, Chromium, git/git-lfs, tmux, sqlite, compilers, Python,
# ripgrep/fd, etc.; this layer adds SSH client support for image builds and
# release publishing from inside an Atelier workspace.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*

ENV PI_CODING_AGENT_DIR=/home/atelier/.pi/agent

RUN mkdir -p /home/atelier/.pi/agent \
 && chown -R atelier:atelier /home/atelier/.pi

WORKDIR /work
