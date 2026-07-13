# Atelier Guide

Atelier is a self-hosted browser app for working with coding agents in isolated Docker workspaces. Each workspace has its own filesystem, tools, terminals, previews, and agent conversations.

## 1. What Atelier Is

- A **workspace** is an isolated development environment. Its project files live under `/work` inside the workspace.
- An **agent** is a coding assistant running inside a workspace. A workspace can have more than one agent.
- A **repository** is a saved Git URL that Atelier can clone into new workspaces.
- A **tab** is a tool inside a workspace, such as an Agent, Terminal, Browser preview, VS Code, or Desktop.

## 2. Getting Set Up

On first use, Atelier guides you through setup:

- **Git identity**: the name and email used for commits created in workspaces.
- **GitHub**: a token Atelier can use to clone and push private GitHub repositories.
- **Models**: connect model providers and choose favorite models shown in agent prompt boxes.

Open **Settings** from the sidebar to change these later.

For programmatic workspace creation, see [REST API](./rest-api.md).

## 3. Workspaces

Create a workspace from the sidebar:

- **New workspace** creates an empty workspace.
- A repository row creates a workspace cloned from that repository.
- When adding a repository, append `#branch` to use a specific branch, for example `https://github.com/example/app.git#main`.

Workspace actions:

- Rename with the pencil icon.
- Park with the sleep icon to keep it but skip it during next/previous workspace navigation.
- Delete with the trash icon. Atelier warns before deleting uncommitted changes or unpushed commits.

Agents can also fork their current workspace with the `fork_current_workspace` tool. A fork creates a fresh container from the same workspace image and copies the current workspace's entire `/work` folder, including unversioned files. It does not copy live terminals, tab layout, running processes, or agent conversation history. If the tool includes an initial prompt, Atelier runs that prompt in a new fresh agent context in the fork. Repository workspaces share `/persistent`, so the spawning workspace and the fork can use `/persistent` as a communication channel for notes, handoff files, or artifacts that should outlive either workspace.

## 4. Working With Agents

Use an Agent tab to ask for code changes, explanations, reviews, or debugging help.

- Choose the model and thinking level from the controls below the prompt.
- Drop files onto the prompt to attach them.
- Type `@` followed by part of a filename to fuzzy-search files and directories from the agent's working directory. Press **Tab** to request path completion for any other word at the cursor. Relative, absolute, and `~/` paths are supported.
- While an agent is running, use **Stop**, **Steer**, or **Follow-up**.
- Use **New Agent** from the tab group menu to add another agent.
- Use **Rewind** on an earlier user message to continue from that point in the conversation.

Agents run inside the workspace and can read and edit files under `/work`.

### Agent instructions

Atelier loads repository agent instructions from `AGENTS.md` and, if present, `.atelier/AGENTS.md`. Use `AGENTS.md` for normal coding-agent instructions that should apply in any agent tool. Use `.atelier/AGENTS.md` for Atelier-specific instructions about how agents should present their work, such as when to use previews, screenshots, embedded files, videos, or other Atelier UI affordances.

When both files exist, Atelier applies `AGENTS.md` first and `.atelier/AGENTS.md` second.

### Prompt templates

Prompt templates are reusable prompts stored in the workspace repository. Add Markdown files under `.atelier/prompts`; `.atelier` is the idiomatic Atelier configuration directory. Atelier also reads `.pi/prompts` for convenience and compatibility, but prefer `.atelier/prompts` for new templates. If both directories contain a template with the same filename, the `.atelier` template is used.

Each `*.md` file becomes a slash command named after the file. For example, `.atelier/prompts/land.md` is available as `/land` in the agent prompt box. Atelier also includes a built-in `/land` template: "Commit and push your work, rebasing when necessary. when succesful, delete this workspace". A repository-provided `/land` template takes precedence over the built-in one. Type `/` to see matching templates, then submit the slash command with any arguments to expand it into the full prompt.

To add a new prompt template:

1. Create `.atelier/prompts/<name>.md` in the repository.
2. Optionally add frontmatter with `description` and `argument-hint`.
3. Write the prompt body, using argument placeholders if needed.

Example `.atelier/prompts/land.md`:

```markdown
---
description: Land the workspace
argument-hint: "[branch]"
---
Review the current changes, run the relevant checks, commit them, and prepare to push to ${1:-main}.
```

Supported placeholders in the body:

- `$ARGUMENTS` or `$@`: all arguments as typed.
- `$1`, `$2`, etc.: individual arguments.
- `${1:-main}`: an argument with a fallback value.
- `${@:2}` or `${@:2:3}`: an argument slice.

## 5. Workspace Tools

Use the tab group `+` menu to open tools:

- **Terminal**: shell access inside the workspace.
- **Browser**: preview web apps running in the workspace.
- **VS Code**: browser-based VS Code for the workspace.
- **Desktop**: a graphical desktop when needed.

Tabs can be moved, closed, split into groups, and arranged side by side.

## 6. Previewing Apps and Outputs

Atelier exposes workspace web servers on ports `3000` through `3010`. Start dev servers on one of those ports, then open a Browser tab to preview them.

Agents can show generated files inline using:

```text
{{atelier:embed /work/path/to/file}}
```

This is useful for screenshots, images, videos, HTML pages, and other outputs.

## 7. Git and Repositories

Atelier clones repository workspaces from the saved Git URL. For GitHub repositories, Atelier can use the GitHub token configured in Settings.

The token is handled by Atelier for Git operations. It is not stored as the real token in the workspace environment.

Before deleting a workspace, Atelier checks for uncommitted changes and unpushed commits. If work should be kept, commit and push it before deleting.

Repository workspaces also include `/persistent`, a directory shared by all workspaces for that saved repository. Use it for files you want to keep across workspaces but not commit to Git.

### Slopometer

Repository workspace rows include a slopometer when there are uncommitted line changes. It shows net implementation lines and inverse net test lines, for example `+23 t:-12`. A zero side is omitted. Positive values are colored as more slop; negative values are colored as less slop, so adding tests normally appears as a negative `t:` value. Hover over the slopometer to see the full implementation/test breakdown.

Atelier has built-in basic test-file detection for paths such as `test/`, `tests/`, `spec/`, `__tests__/`, `*.test.*`, and `*.spec.*`. You can add repository-specific test path filters in `.atelier/workspace.json`:

```json
{
  "version": 1,
  "slopometer": {
    "testPathPatterns": ["(^|/)e2e(/|$)", "\\.stories\\.tsx$"]
  }
}
```

`slopometer.testPathPatterns` entries are case-insensitive JavaScript regular expressions matched against normalized repository-relative paths. They are additional filters; the built-in test detection still applies.

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
