# Workspace Filesystem Contract

This document defines the filesystem contract between Atelier and an Atelier workspace container.

A workspace is represented by a Docker container. In the first version, the actual working filesystem is ephemeral: if the container is removed, the workspace worktree is gone.

Atelier does host-mount the workspace control directory, `/.atelier`, so the host app can read and write workspace metadata and agent tree data without `docker exec`.

## Top-level paths

Inside every Atelier workspace container:

```text
/.atelier/    Atelier control/data directory, host-mounted read/write
/repos/   normal working directory for agents and tools
```

Agents should normally work under:

```text
/repos
```

Managed repositories should be cloned only through:

```bash
atelier clone <managed-repo-name>
```

## Host mounts

Atelier creates a host-side control directory for each workspace and mounts it at `/.atelier` read/write.

Example host layout:

```text
$ATELIER_DATA_DIR/repos-control/<control-key>/
  agent_tree.jsonl
  title
  tools/
  tmp/
```

Mounted into the container as:

```text
/.atelier
```

The control key does not need to be the workspace ID. The workspace ID is the Docker container ID. Atelier links container to control directory using a Docker label.

Recommended labels:

```text
com.atelier.type=workspace
com.atelier.control-key=<control-key>
```

Atelier also mounts the host managed repo store read-only under `/.atelier`:

```text
$ATELIER_DATA_DIR/managed-repos -> /.atelier/readonly-hostmounted-repos:ro
```

This may be implemented as a nested Docker mount over `/.atelier/readonly-hostmounted-repos`.

## `/.atelier`

`/.atelier` is the Atelier control directory inside the workspace container.

It contains workspace-local Atelier state, agent tree state, tool support files, and read-only host-mounted repo references.

Initial layout:

```text
/.atelier/
  agent_tree.jsonl
  title
  tools/
  readonly-hostmounted-repos/
  tmp/
```

### `/.atelier/agent_tree.jsonl`

The primary persisted workspace agent tree file.

This uses Pi's JSONL session tree format.

Example:

```jsonl
{"type":"session","version":3,"id":"...","timestamp":"2026-06-02T12:00:00.000Z","cwd":"/repos"}
```

### `/.atelier/title`

The workspace title file.

This is a plain text file containing the user-visible workspace title.

Example:

```text
Add dark mode toggle
```

It is valid for this file not to exist yet. If `/.atelier/title` does not exist, Atelier displays the workspace as:

```text
unnamed
```

Once the user starts doing things, either the user or Atelier may decide to name the workspace by writing this file.

### Multiple agents

Multiple agents in one workspace are represented as named leaves in the same Pi session tree.

Atelier uses Pi `custom` entries for Atelier-specific agent metadata. These entries do not participate in LLM context.

Example custom entry:

```json
{
  "type": "custom",
  "id": "...",
  "parentId": "...",
  "timestamp": "2026-06-02T12:05:00.000Z",
  "customType": "atelier.agent",
  "data": {
    "agentId": "primary",
    "role": "implementation",
    "title": "Primary agent",
    "leafId": "..."
  }
}
```

When an agent advances to a new leaf, Atelier appends another `atelier.agent` custom entry with the updated `leafId`.

The latest `atelier.agent` entry for a given `agentId` is authoritative.

Atelier should be the only writer to `agent_tree.jsonl`, or writes must be serialized with a file lock. Multiple independent Pi processes must not append to the same agent tree file concurrently without coordination.

### `/.atelier/tools`

Support files for Atelier workspace tooling.

This directory is part of the host-mounted `/.atelier` control directory, so Atelier can install or update workspace tools from the host.

The `atelier` CLI itself should be available on `PATH`, preferably at:

```text
/usr/local/bin/atelier
```

If `atelier` is available at `/usr/local/bin/atelier`, it should be a symlink into `/.atelier/tools`, for example:

```text
/usr/local/bin/atelier -> /.atelier/tools/atelier
```

This makes the public CLI stable while allowing Atelier to mount or update workspace tools through `/.atelier/tools`.

Agents should invoke the public command:

```bash
atelier clone <managed-repo-name>
```

They should not rely on internal files under `/.atelier/tools` unless explicitly instructed.

### `/.atelier/readonly-hostmounted-repos`

Read-only host-mounted view of Atelier managed bare repositories available to this workspace.

Example:

```text
/.atelier/readonly-hostmounted-repos/
  webshop-frontend.git/
  billing-service.git/
```

This path is mounted from Atelier's managed repo storage. It is read-only inside the workspace.

The `atelier clone` command uses this directory to perform fast local/reference clones.

A managed repo's name is the bare repo directory basename without `.git`.

```text
/.atelier/readonly-hostmounted-repos/webshop-frontend.git
```

corresponds to:

```text
webshop-frontend
```

### `/.atelier/tmp`

Workspace-local temporary files used by Atelier tooling.

No durable semantics.

## Managed repo working trees

Managed repo working trees live under `/repos`.

Default clone destination:

```text
/repos/<managed-repo-name>
```

Example:

```text
/repos/webshop-frontend/
/repos/design-tokens/
```

This keeps paths natural for agents:

```text
/repos/webshop-frontend/src/App.tsx
```

Atelier discovers cloned managed repos by scanning `/repos` for Git working trees and checking whether they are clones of managed repos.

A Git working tree under `/repos` is considered a managed repo clone if:

1. it is inside `/repos`,
2. it is not inside `/.atelier`,
3. it has a configured remote that points at a repo under `/.atelier/readonly-hostmounted-repos`, and
4. the target bare repo basename corresponds to a managed repo name.

The initial implementation may scan only shallow paths, for example direct children of `/repos`, and can expand later if needed. It should ignore obvious dependency/cache directories such as `node_modules`, `.venv`, `vendor`, `.cache`, and nested `.git` directories inside already-discovered repos.

No separate persisted workspace repo manifest is required in the first version.

## `atelier clone`

The `atelier clone` command clones a managed repo into the workspace.

Usage:

```bash
atelier clone <managed-repo-name> [--path <path>]
```

Default destination:

```text
/repos/<managed-repo-name>
```

Behavior:

1. verify it is running inside an Atelier workspace by checking `/.atelier`
2. verify the managed bare repo exists at `/.atelier/readonly-hostmounted-repos/<name>.git`
3. clone into `/repos/<name>` by default, or the explicit `--path`
4. keep the clone inside `/repos`
5. configure the clone's remote to point at the managed repo using a read-only/local path where possible
6. fail clearly if destination already exists or the managed repo is unknown

Initial implementation may shell out to Git, for example:

```bash
git clone \
  --reference /.atelier/readonly-hostmounted-repos/webshop-frontend.git \
  /.atelier/readonly-hostmounted-repos/webshop-frontend.git \
  /repos/webshop-frontend
```

Use `--reference`, not `--reference-if-able`. If the reference clone does not work, that is a bug in Atelier's workspace setup.

The exact clone implementation may change, but the public contract remains `atelier clone <name>` and the default resulting clone path remains `/repos/<name>`.

## Git diff base

Atelier does not persist clone base SHAs in the first version.

For review and merge, Atelier calculates the base from Git history:

```bash
git merge-base <target-branch-head> <workspace-head>
```

The default target branch is the managed bare repo's symbolic `HEAD`.

## Workspace identity

The Docker container ID is the workspace ID.

Atelier lists workspaces by scanning Docker containers with Atelier workspace labels.

The workspace title is read from:

```text
/.atelier/title
```

If this file does not exist, Atelier displays the workspace as `unnamed`.

## Summary

Persisted workspace state in the first version is intentionally minimal:

- workspace identity: Docker container ID
- host/control mapping: Docker label `com.atelier.control-key`
- workspace control files: host-mounted read/write at `/.atelier`
- workspace title: `/.atelier/title`, or `unnamed` if absent
- conversation/tree/agent branches: `/.atelier/agent_tree.jsonl`
- active/named agents: Pi `custom` entries with `customType: "atelier.agent"`
- cloned managed repos: discovered by scanning `/repos` for Git working trees whose remotes point at `/.atelier/readonly-hostmounted-repos/*.git`
- managed repo metadata: derived from bare Git repos under `/.atelier/readonly-hostmounted-repos/*.git`

There is no separate workspace database record, repo manifest, stored clone base SHA, or `workspace_info.json` in the first version.
