# Atelier workspace image

Workspace container image used by Atelier.

It extends `mcr.microsoft.com/devcontainers/base:ubuntu-24.04` and adds:

- `tmux`
- recent ncurses terminfo
- `/etc/tmux.conf` configured for `xterm-256color` + RGB
- UTF-8 locale defaults (`LANG=C.UTF-8`, `LC_ALL=C.UTF-8`)
- the `atelier` user and `/repos` / `/.atelier` directories

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
