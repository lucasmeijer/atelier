# Workspace Docker snapshotter

The Atelier container image includes the experimental snapshotter, shared content
store/diff service, BuildKit and local registry. The Linux installer starts
one installation-owned instance of each alongside the app. New workspaces automatically register their private
runtimes with that installation; existing workspace stores are not converted.

## Installation behavior

- Root installations use the container entrypoint's `--own-snapshotter` option.
  The app waits for the snapshotter, registry and a BuildKit worker to become ready
  and continues to run as an unprivileged user. Services run as root in the same
  container; no sibling service containers are launched.
- Starting the image without that option does not create another adapter. Nested
  installations use the connection supplied by their containing workspace. The
  containing workspace supplies the connection and socket mounts. An explicitly
  independent installation must instead supply its own persistent runtime mount
  and the ownership option.
- Owned startup requires dedicated persistent backing at the same absolute path
  seen by Docker. The installer supplies the bind mount and privileged execution.
  No host shared-mount setup or additional systemd unit is required.
- A second owner of the same store fails instead of replacing the first owner's
  listeners. Ownership covers the whole stack until all its services have stopped.
  Failure of any owned service stops the app and its remaining services visibly.
  Normal shutdown stops the app, builder, registry and snapshotter in that order;
  the app's exit status is preserved. Restart restores non-retired client sockets.
- The self-update installer contract has changed. Upgrading from the previous
  contract requires rerunning the installer. Subsequent self-updates retain the
  runtime mount, ownership option and privileged execution.
- Workspace creation records a fresh client identity before registering it. The
  same request is idempotent; retirement cannot be undone by a late registration.
  Deletion and failed provisioning retire their client after removing the container.
  Cleanup errors preserve the record rather than losing track of retained data.
- Unix administrative access is trusted within the mounts supplied to workspaces,
  including users with different host-aligned UIDs. It is not a hostile-tenant seam.
- Builder cache and registry data persist in the existing installation runtime
  mount. Their Unix sockets travel with the inherited connection; their storage
  directories are not mounted into workspaces. The builder uses a loopback-only
  registry bridge with a stable, automatically assigned port; no public registry
  port is exposed. Creators bridge their own loopback to the inherited socket and
  must share a network namespace with their Docker daemon (as installed).
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
  through the workspace's inherited socket, with their requested aliases restored.
  Explicit upstream digest references retain their original pull path so their
  manifest identity is not changed by platform-filtered republication.
- Private containerd instances use installation-owned content and diff services
  through their existing client socket. Image names, metadata, containers and
  volumes remain private. Immutable compressed blobs are retained centrally;
  client pruning cannot delete another client's export data. Unfinished uploads
  are client-scoped and reclaimed on retirement, including interrupted retirement.
- Pulls register all image blobs before reusing an unpacked chain. The shared diff
  service skips extraction only for a previously verified blob and matching parent
  chain. This preserves warm reuse without creating unexportable images.
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
measurement boundaries and metrics, including concurrent warm creation.

## Current evidence and limits

The Linux ARM64 experiment exercised cross-workspace reuse, private writes,
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

A bounded root-owned service check also exercised registry blob persistence,
BuildKit cache reuse after restart, COPY invalidation, unprivileged clients using
only inherited sockets, concurrent independent owners, duplicate-owner rejection
and app shutdown after each service's failure. A later repository-build check used
both a root creator and a workspace-local creator, verifying digest identity,
COPY invalidation, ignored-input reuse and an unpublished local base. It did not
run a full nested app.

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
  those workspaces to select the shared content/diff plugins. This does not repair
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
