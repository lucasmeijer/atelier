# Workspace Docker snapshotter

The Atelier container image includes the experimental snapshotter, shared content
store/diff service, BuildKit and local registry. The Linux installer starts
one installation-owned instance of each alongside the app. New workspaces automatically register their private
runtimes with that installation; existing workspace stores are not converted.

## Installation behavior

- Root installations start the owned services by default, without an entrypoint flag.
  The app waits for the snapshotter, registry and a BuildKit worker to become ready
  and continues to run as an unprivileged user. Services run as root in the same
  container; no sibling service containers are launched.
- Nested image launches must pass `--nested`. They use the connection supplied by
  their containing workspace, which supplies the connection and socket mounts.
  Startup fails if `/.atelier/docker-runtime.json` is missing or unreadable. There
  is no automatic mode detection or fallback. An independent installation omits
  the flag and must supply its own persistent runtime mount and privileges.
- Owned startup requires dedicated persistent backing at the same absolute path
  seen by Docker. RAM-backed `tmpfs`/`ramfs` mounts are rejected before services
  start. The installer supplies the disk-backed bind mount and privileged execution.
  No host shared-mount setup or additional systemd unit is required.
- A second owner of the same store fails instead of replacing the first owner's
  listeners. Ownership covers the whole stack until all its services have stopped.
  Failure of any owned service stops the app and its remaining services visibly.
  Normal shutdown stops the app, builder, registry and snapshotter in that order;
  the app's exit status is preserved. Restart restores non-retired client sockets.
- The installer contract is `owned-snapshotter-v2`: standalone startup is now the
  default and `--own-snapshotter` is no longer accepted. Reinstall older deployments
  using the matching installer rather than self-updating with their old startup
  command. Nested launches must explicitly select `--nested`. No host Docker
  configuration changes are required. Recreate older workspaces with the current
  image to receive the MagicDNS connection, DNS settings and private Docker trust
  configuration.
- Workspace creation records a fresh client identity before registering it. Nested
  descriptors also identify their creator; registration persists immutable parentage.
  The same request is idempotent; retirement cannot be undone by a late registration.
  Deletion and failed provisioning remove the container with `docker rm --volumes`,
  then retire its client subtree. The entire subtree is tombstoned before cleanup,
  so interrupted retirement cannot restore descendant sockets or unfinished uploads.
  Cleanup errors preserve the record rather than losing track of retained data.
- Unix administrative access is trusted within the mounts supplied to workspaces,
  including users with different host-aligned UIDs. It is not a hostile-tenant seam.
- Builder cache and registry data persist in the installation runtime mount;
  their storage directories are not mounted into workspaces. BuildKit retains its
  inherited Unix socket. The registry listens only on `127.0.0.1`, on a port
  allocated in 42000–42999 and persisted in `registry-port`.
- The owner configures Tailscale Serve TCP forwarding on the same port. It uses
  the existing LocalAPI/Serve configuration lock, preserves unrelated HTTPS
  routes, rejects conflicting services and Funnel exposure, and removes only its
  own forwarding rule during shutdown. Startup republishes the rule; Tailscale
  retains its background configuration across tailscaled restarts.
- Host Docker and the installation-owned BuildKit worker use loopback. Workspace
  Docker and nested creators use the inherited MagicDNS hostname and port. No
  Tailscale IP is persisted, so changing the node IP does not require changing
  clients. Renaming the node's MagicDNS hostname still requires recreating
  workspaces that reference the old name.
- Workspace containers and their Docker daemons use Tailscale DNS
  (`100.100.100.100`). Private daemons trust HTTP for the exact registry hostname
  and port, and workspace proxy bypass entries include that hostname. Host
  Docker needs no extra HTTP trust configuration, daemon reload or restart.
- The entire machine and tailnet are trusted. Registry HTTP has no authentication;
  Tailscale encrypts traffic crossing the tailnet. No custom registry relays,
  certificates, new environment variables or manual firewall rules are required.
- BuildKit has its own cache, separate from shared image-runtime layers. Direct builds
  can reuse that cache across clients and root-container restarts; changed COPY
  inputs invalidate their dependent build steps.
- Repository Dockerfiles now build through shared BuildKit, publish by digest and
  pull that exact result into the creator's Docker daemon. `FROM atelier-workspace`
  selects the actual base image, including locally built bases. Each build solves
  the current context instead of trusting an existing Dockerfile-derived tag.
  Dockerfile-specific ignore rules take precedence over the context .dockerignore.
- Runtime default-image generation uses the shared builder too, preserving its
  generated tag. Pre-baked image pulls and the standalone release-image scripts
  remain unchanged. Existing workspaces keep their current Docker stores.
- Tagged/local preload images are published before startup and pulled by digest
  directly from the inherited registry address, with their requested aliases restored.
  Explicit upstream digest references retain their original pull path so their
  manifest identity is not changed by platform-filtered republication.
- Private containerd instances use a supervised workspace-local snapshotter and
  installation-owned content and diff services through their existing client socket.
  The creator Docker daemon supplies an anonymous volume at
  `/var/lib/atelier-private-docker`: Docker data, containerd metadata and private
  snapshot backing live in its `docker`, `containerd` and `snapshots` directories.
  Parking preserves this volume; deleting the workspace with `--volumes` removes
  it, including deeper nested Docker volumes and writable snapshots. Unrelated
  workspaces and installation-owned image backing remain intact.
- The local snapshotter combines private uppers and private committed ancestors
  (including Docker init snapshots) with read-only installation image directories.
  It persists shared ancestry in the upstream OverlayFS backend's own transaction,
  not a second alias journal. Mount specifications are executed by the workspace
  runtime; there are no installation-owned per-container execution mounts.
  Shared image resolution allocates no temporary snapshots. Private image commits
  and further descendants remain local until acquired through the shared image path.
- Image names, metadata, containers and volumes remain private. Immutable compressed
  blobs are retained centrally; client pruning cannot delete another client's export
  data. Unfinished uploads are client-scoped and reclaimed on subtree retirement,
  including interrupted retirement. The shared backing bind is read-only inside
  workspaces; central image extraction runs in the owner's writable namespace.
- On verified warm hits, the local coordinator registers the exact requested
  compressed blob through the running private containerd, protects it with active
  manifest leases, then asks the shared snapshotter to adopt retained backing.
  Only then does it return AlreadyExists. No physical temporary image snapshot is
  allocated. Lookup does not create aliases; adoption rechecks content, ancestry
  and retirement under the shared lock.
- Cold or unverified representations retain the ordinary prepare/acquire/apply/
  commit path. The shared diff service can still skip extraction after content
  acquisition. Content/diff services, shared image aliases and their recovery remain
  installation-owned. Private filesystem diff generation and application run through
  containerd's local walking differ, including Docker commit and export.
- Published build outputs can be reused and preloaded by metadata-only private
  clients without publishing their compressed blobs again. Concurrent
  same-process publications share one push and temporary-tag lifetime.

## Observable behavior we care about

- Each workspace has its own Docker containers, image names, tags and volumes.
  Ordinary workspace-local bind paths and published ports keep their meaning.
- Images need no predefined allowlist. First use may download and unpack missing
  layers. Later use from a fresh workspace reuses retained layers without
  downloading or extracting them again, including ancestry shared by different
  images.
- A workspace benefits from another workspace's images while that workspace is
  still running and after it has been deleted.
- Container filesystem writes remain private. Removing containers, pruning images
  or deleting a workspace must not break another workspace's running containers
  or images. Deletion reclaims the deleted workspace's private container data.
- Parking preserves workspace state. Resuming restores access to that state;
  process memory need not survive.
- Restarting the shared runtime must preserve access to retained images and
  workspace state. Running containers must not require it to serve each file read.
- Nested workspace creators get the same reuse and private Docker behavior, rather
  than starting another independent shared cache at each nesting level.
- Two clients requesting an uncached layer concurrently must both obtain correct
  files without exposing partially extracted data.
- A saved image must load and run in a fresh, disconnected runtime. Reporting
  successful export/import while producing an unusable image is not acceptable.

The [performance scenario matrix](PERFORMANCE.md) defines the corresponding
measurement boundaries and metrics, including concurrent warm creation. The
historical local-coordinator comparison measured 23% lower warm
creation latency and 57% lower eight-way per-client latency versus the portable
physical-snapshot path, with zero temporary warm image snapshots. These numbers
predate volume-backed private snapshots and are not measurements of that change.

## Current evidence and limits

The volume-backed hybrid implementation was exercised with real Docker root
filesystems on an isolated Linux amd64/ext4 runtime using the production snapshotter
and workspace supervisor/configuration. Three private clients reused the same 20
immutable backings. Three-level private writes, active middle-container deletion
(including physical backing and mount-reference checks), park/resume, pruning,
local/shared snapshotter SIGKILL recovery, two-generation private image commits,
registry publication, export and disconnected save/load/run passed. Whiteouts and
non-root file ownership survived. This was not a full installed Atelier deployment,
a production network test, an ARM64 hybrid runtime test or a performance benchmark.

The earlier Linux ARM64 experiment exercised cross-workspace reuse, private writes,
workspace-local binds and ports, deletion and pruning with overlapping owners,
park/resume, graceful shared-runtime restart, concurrent cold pulls, and a nested
workspace with its own Docker daemon. Warm real-image pulls transferred only
manifest/config metadata and did not extract image layers.

The export failure is fixed for the shared-content runtime. An ARM64 Docker
29.1.3/containerd 2.2.2 check saved a warm-pulled image, loaded it into a fresh
network-disabled ordinary Docker runtime with no shared-store mounts, and ran it.
A locally committed two-layer image preserved an added file and a whiteout through
push to a separate registry, warm pull, save, offline load and run. This still
worked after deleting the original client and SIGKILL/restarting the adapter.
A fresh post-restart client reused both layers with no registry blob requests.
A bounded two-service Compose check exercised service DNS, published ports,
workspace-local bind paths and a named volume surviving `compose down`.
See [the portability evidence](PORTABILITY.md) for scope and reproduction details.

Before the direct-TCP change, a bounded root-owned service check also exercised registry blob persistence,
BuildKit cache reuse after restart, COPY invalidation, unprivileged clients using
only inherited sockets, concurrent independent owners, duplicate-owner rejection
and app shutdown after each service's failure. A later repository-build check used
both a root creator and a workspace-local creator, verifying digest identity,
COPY invalidation, ignored-input reuse and an unpublished local base. It did not
run a full nested app.

The Serve transport was checked on a real Linux ARM64 Tailscale host: host
loopback pushes/pulls without Docker configuration changes, MagicDNS access from
nested Docker daemons, digest identity, a 140 MiB download with checksum validation,
registry restart, and forwarding-rule recreation without changing existing HTTPS
routes. The implemented supervisor was also exercised with a real Atelier workspace
preload and builds from both root and workspace creators; shutdown removed only
its registry rule and restart reused the same port. Tailscaled restart and actual
node IP changes were not forced on the shared host; mocked LocalAPI tests cover
stable connection identity when the reported IP changes.

Other limits:

- Privileged, trusted Linux workspaces with one fixed ownership/unpack profile.
  Alternate UID/GID mappings and hostile-client isolation are not supported.
- Abrupt snapshotter termination is recovered before client sockets become ready.
  Completed snapshot mutations remain visible; interrupted mutations that did not
  reach backend metadata leave the previous aliases intact. Interrupted client
  retirement finishes on restart, without reclaiming other clients’ image layers.
  Recovery does not repair corruption left by older, unjournaled versions or
  guarantee application filesystem writes survive host power loss.
- Existing experimental workspace stores/configurations are not migrated. Recreate
  those workspaces with the new default image to select volume-backed private
  snapshots and forward creator identities for nested retirement.
  The new installation binary must be deployed with the new workspace image. This does not repair
  incomplete archives or image metadata produced by the older early-reuse path.
- The existing image-outdated check does not detect arbitrary COPY-input edits;
  actual repository builds do re-solve those inputs. Shared-mode creator images
  are not automatically pruned while they may be awaiting container creation.
- Cached image layers and compressed blobs are retained indefinitely. Disk budgets and eviction are
  not implemented. Private container layers are reclaimed on normal cleanup.
- Concurrent cold requests can duplicate downloading and extraction work before
  retaining one completed copy.
- Dynamic registration, normal deletion and failed-provision cleanup are integrated.
  Workspace-level reconciliation after an abrupt app crash still requires work; retained ownership
  records allow deletion to be retried after the adapter becomes available.
- Snapshot parent rebasing is unsupported. This is not a complete implementation
  of every snapshotter extension.
- Compose beyond the bounded check above, Docker Desktop, other runtime versions/platforms and
  30-workspace load have not been validated.

## Local checks

Requires Linux and Go 1.25.1 or later. From this directory:

```sh
go test -count=1 ./...
go build -o dist/docker-snapshotter .
```

These non-UI tests cover scoped reuse, competing cold commits, private data
reclamation, exclusive ownership, readiness and restart of the adapter executable.
Hybrid tests cover mixed private/shared ancestry, namespace isolation, private init
and image commits, views, parent-removal guards, transactional ancestry preservation,
root ownership and pending-initialization recovery. Shared-backing tests verify
read-only resolution without allocations; lineage tests verify subtree tombstones
before cleanup and resumed retirement after interruption.
Content tests cover retained blob reads after client GC/restart, independent upload
references and retirement. Diff tests require matching media type, content and
parent chain, and verify warm reuse returns the complete uncompressed descriptor
without extraction.
Crash tests SIGKILL a subprocess before and after real backend prepare, view,
commit, duplicate-layer commit, removal and retirement transactions, then reopen
the store and verify aliases, ownership and repeated recovery. A bounded ARM64
Docker probe also preserved a running container’s private writes across snapshotter
SIGKILL/restart and retained metadata-only warm pulls. These checks do not establish
full app crash recovery or end-to-end Docker compatibility. The image build runs
them before compiling the executable; they can also be run separately from Bun.
