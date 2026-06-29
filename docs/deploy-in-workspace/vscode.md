# VS Code in Atelier workspaces

Atelier includes browser-based VS Code in each workspace. The default workspace image already contains the VS Code server and Atelier's default VS Code extensions.

## Add extensions permanently for a repository

To make a repository always start with additional VS Code extensions, add `.atelier/Dockerfile` to that repository. The file must start with Atelier's workspace base image:

```Dockerfile
FROM atelier-workspace
```

Install extensions during the image build with the bundled VS Code server CLI and Atelier's shared extensions directory:

```Dockerfile
FROM atelier-workspace

RUN su atelier -c '/home/atelier/.vscode/cli/serve-web/*/bin/code-server \
  --extensions-dir /opt/atelier/vscode-extensions \
  --install-extension rust-lang.rust-analyzer \
  --force'
```

You can install multiple extensions in one Dockerfile:

```Dockerfile
FROM atelier-workspace

RUN su atelier -c '/home/atelier/.vscode/cli/serve-web/*/bin/code-server \
  --extensions-dir /opt/atelier/vscode-extensions \
  --install-extension rust-lang.rust-analyzer \
  --force' \
 && su atelier -c '/home/atelier/.vscode/cli/serve-web/*/bin/code-server \
  --extensions-dir /opt/atelier/vscode-extensions \
  --install-extension dbaeumer.vscode-eslint \
  --force'
```

Atelier starts VS Code with `/opt/atelier/vscode-extensions`, so extensions installed there are available every time a workspace is created from that repository.

## Notes

- Repository Dockerfiles are built once per Dockerfile/source hash and then reused.
- Installing extensions in `.atelier/Dockerfile` makes first workspace creation for that repository slower, but later workspaces reuse the built image.
- The default Atelier extensions are already in `/opt/atelier/vscode-extensions`; do not replace that directory unless you intentionally want to remove them.
