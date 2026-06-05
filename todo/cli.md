# Atelier CLI TODO / Spec

## CLI direction

Use a single CLI name:

```bash
atelier
```

For now, this spec only defines workspace-local behavior. The CLI should refuse to run workspace commands unless it can prove it is inside an Atelier workspace.

The `atelier` executable should be on `PATH`, preferably:

```text
/usr/local/bin/atelier
```

When installed there, it should be a symlink into the workspace control directory:

```text
/usr/local/bin/atelier -> /.atelier/tools/atelier
```

## Workspace detection

A workspace is identified by the Atelier control directory at:

```text
/.atelier
```

Required directory:

```text
/.atelier/
```

Expected files/directories:

```text
/.atelier/
  agent_tree.jsonl
  title                         optional
  tools/
  readonly-hostmounted-repos/
  tmp/
```

`atelier clone` must fail if `/.atelier` is missing or if `/.atelier/readonly-hostmounted-repos` is unavailable.

## Command: `atelier clone`

Clone an Atelier managed repository into the current workspace.

```bash
atelier clone <managed-repo-name> [--path <path>] [--branch <branch>]
```

Examples:

```bash
atelier clone webshop-frontend
atelier clone design-tokens --branch main
atelier clone billing-service --path /workspace/billing
```

## Behavior

`atelier clone` should:

1. Verify it is running inside a workspace.
2. Resolve `<managed-repo-name>` against `/.atelier/readonly-hostmounted-repos/<name>.git`.
3. Choose a destination path.
4. Perform a fast clone using the read-only host-mounted bare repo as a required Git reference.
5. Configure the clone's remote to point at the managed repo.
6. Leave repo discovery to Atelier's `/workspace` scan; do not write a workspace repo manifest.

## Destination path

Default path:

```text
/workspace/<managed-repo-name>
```

If `--path` is supplied:

- path may be absolute or relative to current working directory
- path must be inside `/workspace`
- path must not already contain unrelated files

Keeping clones directly under `/workspace` gives agents natural paths, for example:

```text
/workspace/webshop-frontend/src/App.tsx
```

## Managed repo resolution

The CLI reads available repos from:

```text
/.atelier/readonly-hostmounted-repos/*.git
```

A managed repo's name is the bare repo directory basename without `.git`.

Example:

```text
/.atelier/readonly-hostmounted-repos/webshop-frontend.git
```

resolves as:

```text
webshop-frontend
```

## Clone implementation

Initial implementation can shell out to Git:

```bash
git clone \
  --reference /.atelier/readonly-hostmounted-repos/<repo>.git \
  --branch <branch> \
  /.atelier/readonly-hostmounted-repos/<repo>.git \
  <destination>
```

Use `--reference`, not `--reference-if-able`. If the reference cannot be used, that is a workspace setup bug and the command should fail.

After clone, the remote should point at the managed repo path. The default Git remote name can remain `origin` unless we later decide there is a strong reason to rename it.

Optional later:

- configure partial clone
- configure Git LFS shared object cache
- configure read-only credentials
- support multiple remotes if GitHub mirror behavior becomes relevant

## Workspace repo discovery

`atelier clone` does not write `/.atelier/manifest.json`.

Atelier discovers cloned managed repos by scanning `/workspace` for Git working trees and checking whether they have a configured remote pointing at `/.atelier/readonly-hostmounted-repos/<name>.git`.

A discovered working tree is treated as a managed repo clone if:

1. it is inside `/workspace`,
2. it is a Git working tree,
3. a remote URL points at a bare repo under `/.atelier/readonly-hostmounted-repos`, and
4. that bare repo exists.

The first scan implementation may only inspect direct children of `/workspace`, plus any explicit paths the UI needs later. Avoid descending into dependency/cache directories such as `node_modules`, `.venv`, `vendor`, and `.cache`.

## Diff base

`atelier clone` does not record a clone base SHA.

Atelier calculates review/merge base from Git history:

```bash
git merge-base <target-branch-head> <workspace-head>
```

The target branch defaults to the managed bare repo's symbolic `HEAD`.

## Failure cases

Fail with clear messages when:

- not inside an Atelier workspace
- repo name is unknown
- destination path is outside `/workspace`
- destination already exists and is not empty
- reference clone fails
- clone fails
- HEAD cannot be determined after clone

## UI-created workspaces

When a user starts a workspace from a repo in the Atelier UI:

1. Atelier creates the workspace container.
2. Atelier host-mounts `/.atelier` read/write.
3. Atelier nested-mounts managed repos read-only at `/.atelier/readonly-hostmounted-repos`.
4. Atelier ensures `/usr/local/bin/atelier` points at `/.atelier/tools/atelier`.
5. Atelier runs the clone command inside the workspace, likely via Docker exec:

```bash
docker exec <workspace-container> atelier clone <repo-name>
```

6. The primary agent starts after the clone is complete.

This keeps UI-created and agent-created clones on the same code path.

## Agent prompt rule

Agents should be instructed:

> To work on an Atelier managed repository, use `atelier clone <managed-repo-name>`. Do not manually clone managed repositories. Only repositories cloned with `atelier clone` participate in Atelier Diffs and Merge.

## Open questions

- Whether `atelier clone` should support multiple clones of the same managed repo.
- Whether the CLI should be a standalone binary, shell script, or TypeScript command bundled with Atelier.
- How to implement Git LFS cache sharing.
- How deep Atelier should scan under `/workspace` for managed repo working trees.
