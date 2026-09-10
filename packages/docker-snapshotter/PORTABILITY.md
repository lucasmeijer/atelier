# Shared Docker portability check

This records the original portable implementation. The local coordinator
now avoids temporary warm snapshots while retaining complete content registration.

## Fix

The previous snapshotter returned `AlreadyExists` during `Prepare` when another
client had unpacked a chain. Containerd interpreted that as permission to skip
both extraction **and content acquisition**. The second client's metadata did
not contain the compressed layers, so Docker could successfully save an archive
that could not run elsewhere.

The runtime now uses three services on each existing client socket:

1. **Content:** installation-owned immutable blobs, with private upload refs.
   Each Docker daemon still owns its own metadata database, image names and GC
   decisions. Backend deletion deliberately retains shared blobs.
2. **Snapshots:** `Prepare` returns an active snapshot, allowing containerd to
   register every layer against its own metadata before committing reuse.
3. **Diff:** a previously verified compressed-blob/media-type → uncompressed
   descriptor, together with matching snapshot ancestry, skips extraction.
   `Commit` then replaces the empty extraction snapshot with retained backing.
   Uncached layers use containerd's filesystem applier; ordinary filesystem diff
   operations stay with the client's walking differ.

The verified diff index and blobs survive adapter restart. Client retirement
also removes its unfinished uploads; interrupted retirement repeats that cleanup
before listeners start. New configuration selects the content/diff proxy plugins
without adding sockets, mounts, environment variables or external services.

## Linux ARM64 evidence

Tested on the supplied SSH host with Docker **29.1.3**, containerd **2.2.2**, and
Compose **2.40.3**. Tests used isolated `portfix-*` containers and
`/root/docker-portability-fix`, not the existing Atelier deployment.

| Check | Result |
| --- | --- |
| Cold and fresh-client warm Alpine 3.22 pull/run | Passed; warm Apply logged retained-chain reuse |
| Warm `docker save` | Complete archive: 4,229,632 bytes |
| Load/run in fresh ordinary Docker with `--network none`, no shared mounts | `3.22.5`, `offline-ok` |
| Warm-image push to a new, independent registry | Passed, including the layer blob |
| Docker commit of an added `/marker` and deleted `/etc/alpine-release` | Passed |
| Push/pull/save/offline-load/run of that two-layer image | Added file and whiteout preserved; archive 4,130,304 bytes |
| Original client image prune and retirement | Other clients still ran and exported the image |
| Adapter SIGKILL/restart | Running container retained `/private`; fresh client reused both image layers |
| Fresh post-restart warm pull from test registry | Two reuse events; manifest HEAD only, **no blob requests** |
| Export after retirement/restart, then offline import/run | `portable-layer`, `post-retirement-offline-ok` |
| Bounded two-service Compose workload | Service DNS, published port, local bind, shared named volume passed |
| Named-volume read after `compose down` | `volume-ok` |

The two-layer image's digest was
`sha256:766b5871b112b723ae78d6e0e3fdfb50410ed0407dc026f0e0b89f52c40bab8e`.
The test registry was a separate empty `registry:2` instance on bridge port 5017.
The offline daemon had its own ordinary overlayfs/content stores and no network,
snapshotter socket or shared backing mount.

Harness scripts and service logs are retained on the SSH host under
`/root/docker-portability-fix`. A copy is retained in the project-shared
`/persistent/docker-rewrite-evidence/portability-arm64.tar.gz`.

Useful verification commands while the test containers are running:

```sh
docker exec portfix-final /opt/pinned-bin/docker save \
  -o /workspace-bind/recheck.tar 172.17.0.1:5017/portable/multi:test
cp /root/docker-portability-fix/clients/final/bind/recheck.tar \
  /root/docker-portability-fix/clients/offline/bind/recheck.tar
docker exec portfix-offline /opt/pinned-bin/docker load -i /workspace-bind/recheck.tar
docker exec portfix-offline /opt/pinned-bin/docker run --rm --pull never \
  172.17.0.1:5017/portable/multi:test sh -c \
  'cat /marker; test ! -e /etc/alpine-release'
docker inspect portfix-offline --format '{{.HostConfig.NetworkMode}} {{json .Mounts}}'
```

## Automated checks

- `go test -race -count=1 ./...` in this package: passed, including existing
  subprocess crash-recovery tests and new content/diff regression tests.
- Thirteen focused Bun tests covering shared Docker configuration, registration,
  shared builds and preloads: passed.
- Workspace-module generation followed by full TypeScript check: passed.
- Repository lint and `git diff --check`: passed.

## Still out of scope

Existing experimental workspaces are not migrated; recreate them to select the
new proxy configuration. This does not repair old incomplete archives or image
metadata. Disk budgets/eviction, app-level crash reconciliation, parent rebasing,
hostile-client isolation, a full nested Atelier app, general Compose compatibility
and other Docker versions/platforms remain unestablished. This change fixes
portability and its related first-publication failure, not every experimental
runtime limitation.
