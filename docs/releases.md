# Releases from an Atelier workspace

```sh
bun run release             # latest only
bun run release --stable    # latest + stable (never stable alone)
bun run release --check     # validate the builder without publishing
```

Publishing requires the existing `GH_PACKAGE_TOKEN` with GHCR package write access.
Docker, Buildx, Bun, Git and `flock` are supplied by the Atelier workspace. No GitHub
Actions or host Docker socket is needed.

## What runs

The command fetches `origin/main` and records its exact SHA. It creates/reuses an
explicitly selected, versioned BuildKit container containing `fuse-overlayfs`.
The workspace Docker daemon already uses FUSE; the separate BuildKit daemon must
have its own FUSE binary and snapshotter setting. The builder image definition is
`scripts/release-builder/Dockerfile`. Changing it selects a new builder/cache;
there is no automatic migration or silent native-snapshotter fallback.

Every invocation bootstraps the builder, checks its snapshotter, and exercises
COPY and RUN for amd64 and arm64, exporting a small local OCI archive. `--check`
stops here: it fetches Git and may download/build the local builder and probe,
but never logs into or writes to the registry. It does not prove write credentials
or that a full application build succeeds.

A real release builds an isolated detached worktree of that SHA, not your working
files, and removes the worktree afterward. Your branch and local edits are left
alone. It uses the existing image-building script to reuse/build the deterministic
workspace image and upload the app as `ghcr.io/lucasmeijer/atelier:sha-<full-sha>`.
Channel tags are not passed to the build. An existing commit image is reused, not
overwritten, and its two architectures and revision labels must pass verification.
Rerunning after a completed upload therefore skips the application rebuild.

Before promotion, the command verifies main has not moved. If it has, the command
fails without updating channels; rerun to release the new main. Otherwise it
promotes the verified digest to latest, then optionally stable, checking each tag.
Channel updates are **not atomic**. Status records each channel separately. A
failed promotion may have reached the registry even if its response was lost;
there is no automatic rollback. Inspect the tag/digest or rerun the same release.

An OS lock prevents overlapping releases from the same Git common directory,
including linked worktrees. **It is not a distributed lock:** do not run releases
from two independent workspaces simultaneously. The main check reduces stale
promotions but cannot eliminate a race with another workspace's publisher.

ARM still uses emulation on an amd64 workspace. FUSE fixes layer-copy overhead,
not emulation. Caches persist with this workspace's builder volume, not across
fresh workspaces. Old builder volumes are not automatically deleted by this script.

## Live progress for people and agents

The script is an ordinary foreground CLI: stdout is live and simultaneously saved.
It needs neither tmux nor Atelier to function. For long runs in Atelier, start it
in a persistent tmux session, **present that session with Atelier's `present`
tool**, and read the status file periodically. Screenshots are unnecessary.

```sh
tmux new-session -d -s atelier-release 'cd /work; bun run release; result=$?; printf "\nRelease exited %s\n" "$result"; exec bash'
```

The agent then calls `present` with `kind: "tmux", session: "atelier-release"`.
For evaluation without publishing, use `bun run release --check` instead.
The interactive shell keeps the final transcript visible; the log/status files
remain the authoritative result if the session closes. Ctrl-C interrupts a running
release and forwards termination to its command group; rerun to recover.

At startup the CLI prints absolute log and status paths. Each run has a directory
under Git's common directory, `atelier-releases/<timestamp>-<pid>/`, containing:

- `release.log`: complete live command output (including ANSI phase headings).
- `status.json`: atomically updated phase, elapsed seconds, commit, builder,
  requested channels, individual promotion outcomes, digest and error. A heartbeat
  updates it every five seconds while a command is busy.
- `probe.oci.tar` and `probe/`: the non-publishing builder smoke check.

Find the latest invocation without knowing its timestamp:

```sh
common=$(git rev-parse --path-format=absolute --git-common-dir)
run=$(cat "$common/atelier-releases/last-run.txt")
cat "$run/status.json"
tail -n 20 "$run/release.log"
```

A successful check ends in `state: checked`, a successful release in `published`,
and handled failures in `failed`. Channels stay `pending` in check mode. If the
process is forcibly killed, a stale heartbeat with `state: running` is not evidence
that it is still alive. Logs are local to the workspace; preserve them externally
if needed. Credentials go only to Docker login's stdin, never command arguments.
