# Atelier Guide

Atelier is a self-hosted browser app for working with coding agents in isolated Docker workspaces. Each workspace has its own filesystem, tools, terminals, previews, and agent conversations.

## 1. What Atelier Is

- A **workspace** is an isolated development environment. Its project files live under `/work` inside the workspace.
- An **Agent conversation** is a coding-assistant conversation running inside a Workspace. A Workspace can have more than one Agent conversation.
- A **Project** is a saved Git source and configuration from which Atelier creates Workspaces.
- A **Work view** is a file, terminal, browser preview, VS Code session, or other working surface shown in the Work pane.

## 2. Getting Set Up

On first use, Atelier guides you through setup:

- **Git identity**: the name and email used for commits created in workspaces.
- **GitHub**: a token Atelier can use to clone and push private GitHub repositories.
- **Models**: connect model providers and choose favorite models shown in agent prompt boxes.

Open **Settings** from the sidebar to change these later.

When controlling or staging an Atelier instance programmatically, see [Automating Atelier](./automation.md). The exact machine-readable contract for a running instance is available from `/openapi.json`.

## 3. Workspaces

Create a workspace from the sidebar:

- **New workspace** creates an empty workspace.
- A repository row creates a workspace cloned from that repository.
- When adding a repository, append `#branch` to use a specific branch, for example `https://github.com/example/app.git#main`.

Workspace actions:

- Rename with the pencil icon.
- Park with the sleep icon to keep it but skip it during next/previous workspace navigation.
- Delete with the trash icon. Atelier warns before deleting uncommitted changes or unpushed commits.

Agents can also fork their current workspace with the `fork_current_workspace` tool. A fork creates a fresh container from the same workspace image and copies the current workspace's entire `/work` folder, including unversioned files. It does not copy live terminals, open Work views, running processes, or Agent conversation history. If the tool includes an initial prompt, Atelier runs that prompt in a new fresh agent context in the fork. Repository workspaces share `/persistent`, so the spawning workspace and the fork can use `/persistent` as a communication channel for notes, handoff files, or artifacts that should outlive either workspace.

## 4. Working With Agents

Use an Agent conversation to ask for code changes, explanations, reviews, or debugging help.

- Choose the model and thinking level from the controls below the prompt.
- Drop files onto the prompt to attach them.
- Type `@` followed by part of a filename to fuzzy-search files and directories from the agent's working directory. Press **Tab** to request path completion for any other word at the cursor. Relative, absolute, and `~/` paths are supported.
- While an agent is running, use **Stop**, **Steer**, or **Follow-up**.
- Use **New Agent** from the Agent pane to add another Agent conversation.
- Use **Rewind** on an earlier user message to continue from that point in the conversation.

Agents run inside the workspace and can read and edit files under `/work`.

### Agent instructions

Atelier loads repository agent instructions from `AGENTS.md` and, if present, `.atelier/AGENTS.md`. Use `AGENTS.md` for normal coding-agent instructions that should apply in any agent tool. Use `.atelier/AGENTS.md` for Atelier-specific instructions about how agents should present their work, such as when to use previews, screenshots, embedded files, videos, or other Atelier UI affordances.

When both files exist, Atelier applies `AGENTS.md` first and `.atelier/AGENTS.md` second.

### Agent Skills

Atelier supports the [Agent Skills](https://agentskills.io/) format for reusable, task-specific instructions. Put each skill in its own directory with a `SKILL.md` file under `.atelier/skills`:

```text
.atelier/skills/
└── release-notes/
    ├── SKILL.md
    └── examples.md
```

A skill's `SKILL.md` must include YAML frontmatter with a `description`; `name` is optional and defaults to the containing directory name. Atelier initially gives the agent only each skill's name, description, and file path. The agent reads the full file—and any relative supporting files—only when the task matches, keeping unrelated instructions out of the model context. Loaded skills also appear in slash completion as `/skill:<name>` commands; invoking one explicitly loads its full instructions and passes along any trailing arguments.

Atelier also discovers the open-standard `.agents/skills` location and Pi's `.pi/skills` location for compatibility. If the same skill name exists in more than one location, `.atelier/skills` wins, followed by `.agents/skills`, then `.pi/skills`.

```markdown
---
name: release-notes
description: Draft user-facing release notes from a commit range
---

Read `examples.md`, inspect the requested changes, and draft concise release notes.
```

### Workspace setup

A repository can add `.atelier/setup.sh` to install dependencies or perform other one-time setup for each freshly cloned workspace. Atelier runs the script with `sh` as the `atelier` user from `/work`, after the container starts and before the workspace becomes ready or its initial agent starts.

Setup runs in a tmux session and its live output appears in the workspace creation screen. A non-zero exit marks workspace creation as failed. Copied/forked workspaces skip setup because their files and installed dependencies are copied from the source workspace.

```sh
#!/bin/sh
set -eu
bun install
```

### Prompt templates

Prompt templates are reusable prompts stored in the workspace repository. Add Markdown files under `.atelier/prompts`; `.atelier` is the idiomatic Atelier configuration directory. Atelier also reads `.pi/prompts` for convenience and compatibility, but prefer `.atelier/prompts` for new templates. If both directories contain a template with the same filename, the `.atelier` template is used.

Each `*.md` file becomes a slash command named after the file. For example, `.atelier/prompts/land.md` is available as `/land` in the agent prompt box. Atelier also includes a built-in `/land` template: "Commit and push your work, rebasing when necessary. when succesful, delete this workspace". A repository-provided `/land` template takes precedence over the built-in one. The built-in `/new` command starts a fresh session in the current Agent conversation, preserving the selected model and thinking level. `/name` asks AI to rename the current workspace from the agent conversation, while `/name my-custom-name` applies a name directly. `/park` parks the current workspace. Type `/` to see matching templates and commands, then submit one to run it.

To add a new prompt template:

1. Create `.atelier/prompts/<name>.md` in the repository.
2. Optionally add frontmatter with `description`, `argument-hint`, `quick-launch`, and `hotkey`.
3. Write the prompt body, using argument placeholders if needed.

Example `.atelier/prompts/land.md`:

```markdown
---
description: Land the workspace
argument-hint: "[branch]"
quick-launch: true
hotkey: l
---
Review the current changes, run the relevant checks, commit them, and prepare to push to ${1:-main}.
```

Set `quick-launch: true` to show a compact command button whenever the Agent pane composer is empty, whether or not it has focus. Selecting it expands the template into the composer for review and editing without submitting it. Atelier focuses the composer when doing so will not open a software keyboard; on software-keyboard devices it leaves the composer unfocused. Quick launches do not appear in the new-workspace launch composer and disappear as soon as the user types or starts transcription.

Set `hotkey` to one letter to expand and immediately send that template with Command-Option-letter (for example, `hotkey: l` uses ⌘⌥L). Atelier supplies the modifiers; other shortcut forms are not accepted. If the template is also a quick launch, its button shows the shortcut. Existing Atelier commands take precedence when a letter conflicts.

Supported placeholders in the body:

- `$ARGUMENTS` or `$@`: all arguments as typed.
- `$1`, `$2`, etc.: individual arguments.
- `${1:-main}`: an argument with a fallback value.
- `${@:2}` or `${@:2:3}`: an argument slice.

## 5. Workspace Tools

Use the Work pane `+` menu or mobile More sheet to open Work views:

- **Terminal**: shell access inside the workspace.
- **Browser**: preview web apps running in the workspace.
- **VS Code**: browser-based VS Code for the workspace.

Work views can be selected, reordered, and closed inside the single contextual Work pane.

## 6. Previewing Apps and Outputs

Atelier exposes workspace web servers on ports `3000` through `3010`. Start dev servers on one of those ports, bind them to all interfaces (`0.0.0.0`), then open a Browser view to preview them.

Preview requests pass through Atelier's reverse proxy, so the browser-facing `Host` header depends on the Atelier deployment. Configure development servers with strict host checks to accept requests from any hostname instead of adding the current deployment hostname to an allowlist. This keeps previews working when Atelier's hostname changes or the workspace runs on another Atelier installation.

Atelier publishes preview ports only through its managed ingress. Do not use permissive host validation when the development server is exposed directly on an untrusted network.

Agents can show generated files inline using:

```markdown
![](atelier-embed:/work/path/to/file)
```

This is useful for screenshots, images, videos, HTML pages, and other outputs.

## 7. Git and Repositories

Atelier clones repository workspaces from the saved Git URL. Git submodules are synchronized, initialized, and checked out recursively as part of the reusable project checkout, so fresh workspaces include submodule contents without additional setup. Forked workspaces preserve the source workspace's initialized submodules.

For GitHub repositories and HTTPS GitHub submodules, Atelier can use the GitHub token configured in Settings. The token is handled by Atelier for Git operations, is only offered to HTTPS requests for `github.com`, and is not stored as the real token in the workspace environment.

Before deleting a workspace, Atelier checks the top-level repository and every initialized submodule recursively for uncommitted changes and unpushed commits. If work should be kept, commit and push it before deleting.

Repository workspaces also include `/persistent`, a directory shared by all workspaces for that saved repository. Use it for files you want to keep across workspaces but not commit to Git.

Every workspace includes `/atelier/session-share`, a read-only directory containing JSONL transcript files for workspaces with the same session share key. Repository workspaces use the repository's `sessionShareKey`, which is initially populated from the saved project name; project-less workspaces use the shared `projectless` key. Session files are named with a topic slug plus workspace, agent, and short id components, for example `fix-auth-flow--a1b2c3d4--agent-1--9e8f12.jsonl`. Agents can search prior related work directly from the filesystem with tools such as `ls`, `rg`, `jq`, `head`, or `tail`, but cannot modify these archived session files from inside the workspace. Set multiple saved repositories to the same `sessionShareKey` in Atelier's project store when related repositories, such as frontend and backend projects, should share session history.

## 8. Customizing Workspaces

A repository can customize its workspace image with `.atelier/Dockerfile`. The Dockerfile must start with:

```Dockerfile
FROM atelier-workspace
```

Atelier first resolves the default workspace image produced by Atelier's module build, tags that image locally as `atelier-workspace`, and then builds the repository Dockerfile on top of it.

Example:

```Dockerfile
FROM atelier-workspace
# Atelier image version: 1

RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq-dev

ENV EXAMPLE=value
COPY .atelier/image/example.conf /etc/example.conf
RUN chmod 0644 /etc/example.conf
```

Use this to install packages, add image files, set environment variables, or run build-time setup commands for future workspaces from that repository. Atelier automatically applies fast BuildKit apt caching to simple instructions that start with `RUN apt-get update`, so you do not need to write cache mounts or apt list cleanup in repository Dockerfiles.

Atelier reuses repository images based on the default workspace image plus `.atelier/Dockerfile` contents only. Regular source changes do not rebuild the image. If your Dockerfile copies another file from the repo, bump a version comment in `.atelier/Dockerfile` when that copied file changes.

For repository-specific VS Code extensions, see [VS Code extensions](./vscode.md).
