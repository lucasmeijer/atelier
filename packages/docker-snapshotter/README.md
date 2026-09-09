# Workspace Docker snapshotter

The Atelier container image builds and includes this experimental adapter. The
Linux installer and Linux Docker development launcher explicitly start an owned
instance alongside the app. New workspaces automatically register their private
runtimes with that installation; existing workspace stores are not converted.

## Installation behavior

- Root installations use the container entrypoint's `--own-snapshotter` option.
  The app waits for that particular instance to become ready and continues to run
  as an unprivileged user. The adapter runs as root in the same container.
- Starting the image without that option does not create another adapter. Nested
  installations use the connection supplied by their containing workspace. The
  Docker development launcher forwards its connection and mounts instead of
  starting another owner.
- Owned startup requires dedicated persistent backing at the same absolute path
  seen by Docker. The installer supplies the bind mount and privileged execution.
  No host shared-mount setup or additional systemd unit is required.
- A second owner of the same store fails instead of replacing the first owner's
  listener. Adapter failure causes Atelier to exit visibly. Normal shutdown stops
  the app before stopping the adapter; restart restores non-retired client sockets.
- The self-update installer contract has changed. Upgrading from the previous
  contract requires rerunning the installer. Subsequent self-updates retain the
  runtime mount, ownership option and privileged execution.
- Workspace creation records a fresh client identity before registering it. The
  same request is idempotent; retirement cannot be undone by a late registration.
  Deletion and failed provisioning retire their client after removing the container.
  Cleanup errors preserve the record rather than losing track of retained data.
- Unix administrative access is trusted within the mounts supplied to workspaces,
  including users with different host-aligned UIDs. It is not a hostile-tenant seam.
- Registry and BuildKit ownership are still pending. Existing workspaces are not
  switched away from their current Docker stores.

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

## Current evidence and limits

The Linux ARM64 experiment exercised cross-workspace reuse, private writes,
workspace-local binds and ports, deletion and pruning with overlapping owners,
park/resume, graceful shared-runtime restart, concurrent cold pulls, and a nested
workspace with its own Docker daemon. Warm real-image pulls transferred only
manifest/config metadata and did not extract image layers.

The last export requirement is **not met**: `docker save` and `docker load` both
reported success for an incomplete archive, but running the imported image failed.
Pushing to another repository in the same registry worked; this does not establish
export to an unrelated registry or offline portability.

Other limits:

- Privileged, trusted Linux workspaces with one fixed ownership/unpack profile.
  Alternate UID/GID mappings and hostile-client isolation are not supported.
- Graceful restart was exercised; recovery after an abrupt crash is not safe yet.
- Cached image layers are retained indefinitely. Disk budgets and eviction are
  not implemented. Private container layers are reclaimed on normal cleanup.
- Concurrent cold requests can duplicate downloading and extraction work before
  retaining one completed copy.
- Dynamic registration, normal deletion and failed-provision cleanup are integrated.
  Reconciliation after an abrupt app crash still requires work; retained ownership
  records allow deletion to be retried after the adapter becomes available.
- Snapshot parent rebasing is unsupported. This is not a complete implementation
  of every snapshotter extension.
- Compose as a whole, Docker Desktop, other runtime versions/platforms and
  30-workspace load have not been validated.

## Local checks

Requires Linux and Go 1.25.1 or later. From this directory:

```sh
go test -count=1 ./...
go build -o dist/docker-snapshotter .
```

These non-UI tests cover scoped reuse, competing cold commits, private data
reclamation, exclusive ownership, readiness and restart of the adapter executable.
They do not run Docker or establish end-to-end compatibility. The image build runs
them before compiling the executable; they can also be run separately from Bun.
