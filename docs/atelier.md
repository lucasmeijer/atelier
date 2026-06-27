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

## 3. Workspaces

Create a workspace from the sidebar:

- **New workspace** creates an empty workspace.
- A repository row creates a workspace cloned from that repository.
- When adding a repository, append `#branch` to use a specific branch, for example `https://github.com/example/app.git#main`.

Workspace actions:

- Rename with the pencil icon.
- Park with the sleep icon to keep it but skip it during next/previous workspace navigation.
- Delete with the trash icon. Atelier warns before deleting uncommitted changes or unpushed commits.

## 4. Working With Agents

Use an Agent tab to ask for code changes, explanations, reviews, or debugging help.

- Choose the model and thinking level from the controls below the prompt.
- Drop files onto the prompt to attach them.
- While an agent is running, use **Stop**, **Steer**, or **Follow-up**.
- Use **New Agent** from the tab group menu to add another agent.
- Use **Rewind** on an earlier user message to continue from that point in the conversation.

Agents run inside the workspace and can read and edit files under `/work`.

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

## 8. Customizing Workspaces

A repository can customize its workspace image with `.atelier/workspace.json`:

```json
{
  "version": 1,
  "aptPackages": ["libpq-dev"],
  "env": { "EXAMPLE": "value" },
  "run": ["corepack enable"],
  "files": [
    { "from": ".atelier/image/example.conf", "to": "/etc/example.conf", "mode": "0644" }
  ]
}
```

Use this to install packages, add image files, set environment variables, or run build-time setup commands for future workspaces from that repository.
