# BuildKit needs its own FUSE binary; workspace Docker's binary is not inherited.
FROM moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8
RUN apk add --no-cache fuse-overlayfs=1.16-r0
