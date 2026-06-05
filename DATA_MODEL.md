# Atelier Data Model

## Atelier data root

Atelier stores its host-side durable data under one configurable root directory:

```text
ATELIER_DATA_DIR
```

Recommended production value:

```text
/var/lib/atelier
```

For local development, Atelier can use a project-local directory such as:

```text
./.atelier-data
```

The first version should use only this one path setting. Do not add separate path settings unless a real path-mapping problem appears.

When Atelier itself runs in a Docker container, for example when deployed by Kamal, the host directory should be mounted into the Atelier app container at the same absolute path:

```text
host:      /var/lib/atelier
container: /var/lib/atelier
```

This lets Atelier use the same path both for its own file IO and for Docker bind mounts passed to workspace containers.

Initial layout:

```text
$ATELIER_DATA_DIR/
  managed-repos/
  workspace-control/
```

Atelier needs to know these paths because:

- `managed-repos/` is scanned by Atelier and mounted read-only into workspace containers.
- `workspace-control/<control-key>/` is created/read/written by Atelier and mounted read/write as `/.atelier` in workspace containers.

Workspace worktrees under `/workspace` are not host-mounted in the first version, so Atelier does not need a host path for them.

## Managed repos

### Decision

Atelier will not persist separate application records for managed repos in the first version.

A **managed repo** is defined by the presence of a valid bare Git repository in the managed repo storage directory.

For example:

```text
$ATELIER_DATA_DIR/managed-repos/
  webshop-frontend.git/
  billing-service.git/
  design-tokens.git/
```

The filesystem/Git repository itself is the persisted data model for managed repos.

### Identity and name

The managed repo's identity is its directory name.

```text
managed-repos/webshop-frontend.git
```

corresponds to managed repo:

```text
webshop-frontend
```

Rules:

- managed repo directories live directly under `$ATELIER_DATA_DIR/managed-repos/`
- managed repo directories should end in `.git`
- the managed repo name is the basename with `.git` removed
- names must be unique because directory names are unique
- renaming the directory renames the managed repo

We do not store a separate `id` or `name` field for managed repos.

### Derived metadata

When Atelier needs information about a managed repo, it derives it from the bare Git repository.

Examples:

| Information | Source |
| --- | --- |
| managed repo name | directory basename without `.git` |
| bare repo path | scanned filesystem path |
| remote URLs | Git config, e.g. `remote.origin.url` |
| branches | Git refs, e.g. `refs/heads/*` |
| default branch / merge target | bare repo symbolic `HEAD` |
| current head SHA | resolved `HEAD` commit |
| validity | whether the directory is a valid bare Git repo |

Example commands:

```bash
git --git-dir=/data/atelier/managed-repos/webshop-frontend.git remote get-url origin
git --git-dir=/data/atelier/managed-repos/webshop-frontend.git symbolic-ref HEAD
git --git-dir=/data/atelier/managed-repos/webshop-frontend.git rev-parse HEAD
git --git-dir=/data/atelier/managed-repos/webshop-frontend.git for-each-ref refs/heads
```

### Default branch rule

Atelier's default branch / merge target for a managed repo is the bare repo's symbolic `HEAD`.

For example, if:

```text
HEAD -> refs/heads/main
```

then Atelier treats `main` as the default branch.

This means there is no separate persisted `defaultBranch` setting for managed repos in the first version. If the default branch needs to change, update the bare repo's `HEAD`.

### Registry behavior

The managed repo registry is computed by scanning:

```text
$ATELIER_DATA_DIR/managed-repos/*.git
```

A directory is considered a managed repo if it is a valid bare Git repository.

Invalid directories should be ignored or reported as diagnostics, but they are not managed repos.

### No persisted status

Atelier will not persist managed repo status such as:

- `ready`
- `syncing`
- `importing`
- `broken`
- `archived`
- `lastFetchedAt`
- `lastFetchError`

Those may exist as in-memory or UI-level observations later, but they are not part of the first persisted managed repo data model.

If a Git operation fails, the failure should be reported at the operation level rather than stored as durable managed repo metadata.

### Future sidecar config

Some future project-specific configuration cannot be learned from a bare Git repository, for example:

- dev server command
- dev server port
- test command
- default model
- default thinking mode
- review instructions
- GitHub mirror policy
- LFS policy overrides

When we need this, we can add optional sidecar configuration, for example:

```text
$ATELIER_DATA_DIR/managed-repo-config/
  webshop-frontend.json
```

or a similarly explicit config location.

This sidecar config should be introduced only when a concrete feature requires it. It is not part of the initial managed repo model.
