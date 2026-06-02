# Atelier CLI TODO / Spec

## CLI direction

Use a single CLI name:

```bash
atelier
```

For now, this spec only defines workspace-local behavior. The CLI should refuse to run workspace commands unless it can prove it is inside an Atelier workspace.

## Workspace detection

A workspace is identified by a mounted Atelier tools/state directory at a fixed path:

```text
/.atelier
```

Required files/directories:

```text
/.atelier/
  workspace.json
  tools/
  repos.json
```

`atelier clone` must fail if `/.atelier/workspace.json` is missing or invalid.

Example `workspace.json`:

```json
{
  "workspaceId": "ws_a7f3",
  "workspaceRoot": "/workspace",
  "reposRoot": "/workspace/repos",
  "atelierApiUrl": "http://atelier.internal",
  "workspaceTokenPath": "/.atelier/token"
}
```

## Command: `atelier clone`

Clone an Atelier managed repository into the current workspace.

```bash
atelier clone <managed-repo-name> [--path <path>] [--branch <branch>]
```

Examples:

```bash
atelier clone webshop-frontend
atelier clone design-tokens --branch main
atelier clone billing-service --path /workspace/repos/billing
```

## Behavior

`atelier clone` should:

1. Verify it is running inside a workspace.
2. Resolve `<managed-repo-name>` against Atelier managed repositories.
3. Choose a destination path.
4. Perform a fast clone using Atelier-managed Git object/LFS caches.
5. Configure remotes and Git settings.
6. Record the clone in the workspace manifest.

## Destination path

Default path:

```text
/workspace/repos/<managed-repo-name>
```

If `--path` is supplied:

- path may be absolute or relative to current working directory
- path must be inside `/workspace`
- path must not already contain unrelated files

## Managed repo resolution

The CLI reads available repos from either:

```text
/.atelier/repos.json
```

or Atelier API:

```http
GET /api/workspace/repos
```

Example repo metadata:

```json
{
  "id": "repo_webshop_frontend",
  "name": "webshop-frontend",
  "defaultBranch": "main",
  "internalUrl": "ssh://git@atelier/webshop-frontend.git",
  "referencePath": "/.atelier/git-cache/webshop-frontend.git",
  "lfsCachePath": "/.atelier/lfs-cache/webshop-frontend"
}
```

## Clone implementation

Initial implementation can shell out to Git:

```bash
git clone \
  --reference-if-able /.atelier/git-cache/<repo>.git \
  --branch <branch> \
  <internalUrl> \
  <destination>
```

After clone:

```bash
git -C <destination> remote rename origin atelier
```

The managed remote should be named:

```text
atelier
```

Optional later:

- configure partial clone
- configure Git LFS shared object cache
- configure alternates explicitly
- configure read-only credentials

## Manifest recording

Workspace clone manifest path:

```text
/.atelier/manifest.json
```

Example:

```json
{
  "workspaceId": "ws_a7f3",
  "repos": [
    {
      "managedRepoId": "repo_webshop_frontend",
      "name": "webshop-frontend",
      "path": "/workspace/repos/webshop-frontend",
      "branch": "main",
      "baseSha": "a3f9c1...",
      "remote": "atelier",
      "internalUrl": "ssh://git@atelier/webshop-frontend.git",
      "clonedAt": "2026-06-01T12:00:00Z"
    }
  ]
}
```

`baseSha` is the checked-out HEAD immediately after clone. Atelier later uses this to compute diffs and publish/merge commits.

If the repo is already present in the manifest:

- same path: print existing clone info and exit successfully
- different path: fail unless a future `--also` or `--force` option is added

## Failure cases

Fail with clear messages when:

- not inside an Atelier workspace
- repo name is unknown
- destination path is outside `/workspace`
- destination already exists and is not empty
- clone fails
- HEAD/base SHA cannot be determined
- manifest cannot be updated

## UI-created workspaces

When a user starts a workspace from a repo in the Atelier UI:

1. Atelier creates the workspace container.
2. Atelier mounts `/.atelier` tools/state into the workspace.
3. Atelier runs the clone command inside the workspace, likely via Docker exec:

```bash
docker exec <workspace-container> atelier clone <repo-name>
```

4. The primary agent starts after the clone is complete.

This keeps UI-created and agent-created clones on the same path/code path.

## Agent prompt rule

Agents should be instructed:

> To work on an Atelier managed repository, use `atelier clone <repo-name>`. Do not manually clone managed repositories. Only repositories cloned with `atelier clone` participate in Atelier Diffs and Merge.

## Open questions

- Exact fixed path: `/.atelier` vs `/workspace/.atelier`.
- Whether repo metadata is always mounted as JSON or fetched from Atelier API.
- How to implement Git LFS cache sharing.
- Whether `atelier clone` should support multiple clones of the same managed repo.
- Whether the CLI should be a standalone binary, shell script, or TypeScript command bundled with Atelier.
