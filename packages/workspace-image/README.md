# Atelier workspace image

Workspace container image used by Atelier.

It extends `mcr.microsoft.com/devcontainers/base:ubuntu-24.04` and adds:

- `tmux`
- recent ncurses terminfo, including `xterm-ghostty`
- `/etc/tmux.conf` configured for `xterm-ghostty` + RGB
- the `atelier` user and `/workspace` / `/.atelier` directories

Build locally:

```sh
bun run workspace-image:build
```

Verify:

```sh
bun run workspace-image:verify
```

Publish to GHCR:

```sh
IMAGE=ghcr.io/<owner>/atelier-workspace:latest bun run workspace-image:publish
```

You must be logged in first:

```sh
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```
