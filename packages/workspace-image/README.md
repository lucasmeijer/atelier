# Atelier workspace image

Workspace containers are assembled from module contributions instead of one hand-written Dockerfile.

A module contributes a `workspace-image.json` file at its package root. A checked-out repository can also contribute a root-level `workspace.json` file. The manifest can add Ubuntu packages, files/directories to copy into the image, build-time `RUN` scripts, and default environment variables:

```json
{
  "aptPackages": ["tmux"],
  "files": [{ "from": "workspace-image/rootfs/etc/tmux.conf", "to": "/etc/tmux.conf" }],
  "run": ["echo build step"],
  "env": { "TERM": "xterm-256color" }
}
```

Module names are inferred from their package directory (`packages/workspace-terminal` -> `workspace-terminal`); the base `packages/workspace-image` contribution is named `base`.

Current contributions:

- `packages/workspace-image/workspace-image.json`: base Ubuntu tools, C/C++ toolchain, .NET 10 SDK, Node.js, pi, `atelier` user, `/work`.
- `packages/workspace-terminal/workspace-image.json`: terminal runtime tools, terminfo, `/etc/tmux.conf`.
- `packages/vscode/workspace-image.json`: VS Code apt repo/package, `atelier-start-vscode`, defaults, server and extension prewarm.

On-demand builds:

- `createWorkspace()` always builds/resolves a deterministic local image tag from the generated context before launching a workspace.
- If the tag already exists locally, no rebuild happens; only the first build for a given contribution hash is slow.

When a workspace is created from a repository, a root `workspace.json` in that repository is included in the same context before the hash/tag is computed. Production deployments should therefore include Docker build capability and persistent Docker image/cache storage.
