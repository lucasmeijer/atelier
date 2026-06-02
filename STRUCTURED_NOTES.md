# Structured Notes: Personal AI Programming Setup

## 1. Vision

Build a personal AI programming environment where AI agents can work on multiple software projects. The agents and their side effects should run on a VPS rather than on a local laptop, likely hosted at Hetzner.

The system should make it very fast to start a new agent on a fresh clone of a project, inspect its work, review results, and accept/merge changes.

## 2. Nomenclature

- **Atelier**: the web app/product that manages workspaces, managed repositories, agents, terminals, diffs, artifacts, and previews.
- **Workspace**: the main unit of work. Today a workspace is backed by a Docker container on the VPS; later it may be backed by other sandbox providers.
- **Agent**: one LLM conversation/worker running in a workspace. A workspace usually has one primary agent, but can have multiple agents.
- **Terminal**: a shell attached to a workspace.
- **Diffs**: a workspace-level view over changes across all managed repositories cloned in that workspace.
- **Managed repository**: a canonical/cached repository known to Atelier and available to workspaces for fast reference clones.
- **Workspace repository**: a clone of a managed repository inside a workspace.
- Avoid using **session** as a primary product noun. Use **workspace** when referring to the sandbox/work area, and **agent** when referring to an LLM conversation.

## 3. Trust and Security Model

### Assumptions

- Everyone with access to the server is trusted.
- No strong multi-tenant isolation is required between users or projects.
- Project/user separation is mainly for convenience, not security.
- The goal is to improve on the current local-laptop workflow, not to build a perfect adversarial sandbox.

### Security priorities

- Avoid unnecessary credentials inside workspaces.
- AI inference/API credentials should stay outside the sandbox.
- Workspaces should ideally not need write access to canonical repositories.
- Atelier should perform merges and pushes when the user accepts work.
- Prompt-injection resistance is desirable later, but not required for the first usable version.

## 4. Deployment Model

- The main application is Atelier running on the VPS.
- Deployment will likely use Kamal.
- Atelier itself will probably run in a Docker container.
- It must be able to start, stop, inspect, and clean up workspace backing containers.
- Need to determine how the app container gets Docker control:
  - likely by mounting the Docker socket, or
  - using a Docker API/proxy with constrained permissions.

## 5. Core Architecture

### Main components

1. **Atelier / workspace manager**
   - UI for projects, agents, conversations, review, merge, filesystem access, dev-server previews.
   - Owns the agent loop.
   - Tracks active and historical workspaces.
   - Starts and stops backing containers per workspace.

2. **Workspaces**
   - One Docker container per active workspace.
   - Contains the working checkout and tools.
   - Destroyed or stopped when the workspace is closed/archived.
   - Should expose files, generated artifacts, terminals, and dev servers back through Atelier.

3. **Repository storage / Git server**
   - Host-level storage for canonical/bare repositories.
   - Shared read-only with workspaces for cheap clones.
   - Managed by Atelier.
   - May include an embedded Git/SSH server inside the Atelier container, with persistent storage on the host.

4. **Persistent state**
   - Stores workspaces, histories, labels, backing-container IDs, project metadata, review state, etc.
   - Could use SQLite or workspace history files similar to Pi Coding Agent.

## 6. Repository and Clone Strategy

### Goal

Starting a new agent on a project should be extremely fast, even for large repositories.

### Proposed approach

- Keep bare clones of all relevant Git repositories on the host.
- When starting an agent, create a new clone inside the workspace using Git `--reference` to reuse objects from the managed repository cache.
- Mount the managed repository cache read-only into workspaces.
- Use a similar strategy for Git LFS objects to avoid repeatedly downloading large files from remote servers.

### Open questions

- How are repositories added to the managed repository store?
- Does Atelier expose an HTML UI for adding/removing repositories?
- How should Git LFS be cached?
  - local LFS object cache?
  - host acting as LFS promisor?
  - custom prefetching?
- Should agents receive a custom script for cheap cloning?
- How are project-specific clone settings configured?

## 7. Git Workflow

### Current preference

GitHub is often not the source of truth; it is more like a backup. The canonical repository may live on the VPS.

### Desired direction

- Agents work inside workspace repository clones.
- Agents commit their work locally when presenting results.
- Atelier, not the agent, performs merge/accept actions into the canonical repository.
- Workspaces ideally have read-only Git credentials.
- When the user accepts work, Atelier merges the relevant commits into the main repo.
- Atelier can optionally push to GitHub as backup or for external collaboration.

### Commit-based review

Prefer agents to commit their work before review:

- Supports larger tasks split into multiple commits.
- Allows review per commit or across commit ranges.
- Makes the agent result resemble a pull request.
- Enables better diff tooling and backup.

### Merge UX

The workspace view effectively becomes a pull request:

- Original prompt.
- Conversation/history.
- Commits.
- Diffs.
- Agent summary/presentation.
- Review results.
- Accept/merge button.

Possible merge actions:

- Merge and archive workspace.
- Merge but keep the workspace alive.
- Push to GitHub after merge.
- Archive without merge.

## 8. GitHub Integration

Potential integrations:

- Automatically push VPS canonical repositories to GitHub as backup.
- Fetch/pull updates from GitHub via polling or webhook.
- Support projects where GitHub is the canonical source of truth.
- Git server hooks may handle mirror-pushes to GitHub.

Open questions:

- Should Git hooks live in the embedded Git server?
- How are GitHub credentials stored?
- How are external contributors handled?

## 9. Agent Lifecycle

### Starting an agent

Common workflow:

1. Select project.
2. Click a `+` or “new agent” button.
3. Atelier creates cheap clone.
4. Atelier starts a Docker sandbox/container.
5. User enters task prompt.
6. Agent begins work.

Other workflows:

- Start an agent without a project for general questions/research.
- Start an agent that later clones one or more projects.
- Attach labels/projects to agents for grouping.

### Stopping an agent

- Closing/deleting an agent should stop and remove its Docker container.
- Archiving after merge should likely stop the container but preserve history.

### Fatal errors

If a container disappears while an workspace still expects it:

- The workspace enters a fatal error state.
- History remains readable.
- No further tool calls can be executed.

### Runaway containers

- Every workspace should be created with labels identifying the owning app/workspace.
- On Atelier startup, scan for labeled containers.
- Stop containers that no longer correspond to persisted workspaces.

## 10. Persistence and Durability

### Desired durability

If Atelier is restarted or updated:

- Ideally active workspaces reappear.
- Existing containers continue running.
- Dev-server iframes still work if the container/dev server is alive.

### State to persist

- Workspace ID.
- Conversation history.
- Associated Docker container ID/name.
- Project association and labels.
- User ownership/activity metadata.
- Current status: active, waiting, fatal, archived, merged, etc.
- Last known file/dev-server links.
- Review/subagent relationships.

### Initial acceptable compromise

It may be acceptable in an early version to lose active workspaces during Atelier deploys, but this would be annoying. Persistence should probably be designed in from the beginning if not too costly.

## 11. Web UI Principles

### General style

- Prefer server-rendered HTML, similar to Ruby on Rails.
- Avoid frontend-heavy architecture if possible.
- Use small dynamic enhancements similar to Hotwire or HTMX.
- There will still need to be real-time/dynamic UI for agent streaming, messages, tool calls, etc.

### Tech direction

- Atelier likely implemented in TypeScript to reuse Pi Coding Agent libraries:
  - `pi-agent-core`
  - `pi-ai`
- Need to investigate frontend/server framework choices that support mostly server-rendered HTML.

### UI-first development

Start with UI prototypes before fully implementing the backend. The UI will reveal many design issues early.

Prototype first:

- Project list and project adding flow.
- New agent flow.
- Fullscreen agent conversation view.
- Conversation history inspection.
- Agent result/review/diff view.
- Model and thinking-mode selection.

## 12. Agent Conversation UX

### Main view

- Most of the time the user works with one agent fullscreen.
- The latest message/result should be prominent.
- Earlier conversation history is secondary and may be collapsed by default.

### Reset/context management

Equivalent to Pi Coding Agent `/tree` workflow:

- Add a reset button.
- Optionally generate/preserve a summary.
- Keep the sandbox state unchanged.
- Use this to recover context without discarding work.

### Multi-user interaction

- The system should have accounts.
- Permissions do not need to enforce strict project isolation initially.
- Track who started or interacted with an agent.
- Most agents are single-player; some can be multiplayer.
- If two users submit prompts simultaneously, only the first should be accepted.
- If an agent is already processing another user’s message, the second message should fail and the UI should refresh to the new state.

Possible future permission:

- Not every user may be allowed to press merge.
- Junior users could prepare agent work while senior users approve/merge.

## 13. Filesystem and Artifact Access

### Requirement

Artifacts created inside an workspace should be viewable from the web UI.

Examples:

- Images.
- Videos.
- Generated HTML.
- Logs.
- Build outputs.
- Arbitrary files.

### Proposed URL scheme

Expose agent filesystem paths through Atelier, for example:

```text
/workspaces/:workspace_id/filesystem/<path-inside-workspace>
```

### Path-to-link conversion

If the LLM says:

```text
I created /tmp/image1.jpg and /tmp/video.mp4
```

The UI should convert these into clickable links.

Possible approaches:

1. Prompt the model to reference files in a structured, parseable format.
2. During message rendering, detect path-like strings and check whether they exist in the container.
3. Convert existing paths into HTML anchors.

Structured references are probably better than trying to parse arbitrary text.

## 14. Rich HTML Agent Output

The agent should know that the client can render HTML, not just plain text.

Desired behavior:

- Similar quality to Claude web artifacts/interactions.
- Agents can produce rich visual explanations, interactive elements, or embedded previews.
- Need to research how Claude web/artifacts-like experiences work conceptually.

Open question:

- How should the protocol distinguish normal markdown/text from trusted/sandboxed HTML output?

## 15. Dev Server Preview / Embedded Browser

### Goal

When an agent works on a web app project, the user should be able to view the running app inside the workspace UI without cloning/running locally.

### Desired behavior

- Agent starts the project dev server inside its container.
- Atelier routes an external URL to the appropriate workspace/port.
- UI embeds the app in an iframe.
- The iframe is styled like an embedded browser with browser chrome/address bar.
- The preview can be resized and possibly shown at project-specific dimensions.

### Possible URL scheme

Similar to filesystem exposure:

```text
/workspaces/:workspace_id/ports/:port/
```

or another routed/proxied URL scheme.

### Prompting

Agents should be instructed:

- If working on a web app project, keep a dev server running on the expected port.
- When presenting work, include a structured marker indicating the dev server URL/port.

### Open questions

- Should dev server state be considered sandbox state rather than conversation state?
- Should the system auto-start dev servers based on project settings?
- How should iframe refresh/reload be handled?
- How are multiple viewport sizes configured?

## 16. Code Inspection and Editing UX

Desired introspection features for each workspace:

- Web terminal into the container.
- File browser.
- Code editor, likely Monaco or web-based VS Code-like UI.
- Diff viewer.
- Ability for the user to inspect and maybe modify files manually.

### Diff review UX

Potentially use a high-quality diff viewer, possibly similar to GitHub/PR diffs or a web-based code editor.

Desired features:

- Select commit ranges.
- Default diff range: agent start commit/base → latest agent commit.
- View individual commits.
- Add lightweight inline review comments/instructions.

### Inline feedback to agents

Rather than editing files directly during review, inline comments could be stored as in-memory annotations and then converted into a user message for the agent.

This avoids forcing the LLM to rediscover file edits/comments through tool calls.

## 17. Agent Work Presentation

Agents should be prompted to present results in a consistent way.

Important things to highlight:

- High-level summary.
- Major design decisions.
- Public API changes.
- Serialized state changes.
- Database schema changes.
- Configuration changes.
- Migration/deployment implications.
- Tests run.
- Known limitations.
- Review feedback addressed or intentionally rejected, with reasons.

### Source-code tour idea

Agent or review agent could produce a structured “tour” of the changes:

- File path.
- Commit or diff range.
- Old/new search string or line anchor.
- Annotation text.

The diff viewer could display these as timeline/scroll annotations, perhaps like speech bubbles over relevant parts of the diff.

## 18. Review Workflows

### Basic review feature

Add a review button to an agent result.

When clicked:

1. Start a review subagent.
2. Give it the relevant commits/range.
3. Ask it to identify potential issues.
4. Feed the review result back to the implementation agent.
5. Let the implementation agent decide what to fix and what to reject.
6. Require the implementation agent to summarize handled/rejected review comments in its final presentation.

### Auto-review

Option:

- “Auto-start review when the agent finishes.”

### Review subagents

A subagent is likely just a normal agent with a parent relationship.

UI behavior:

- Root agents shown in main list.
- Subagents nested under parent workspaces.
- Review agent may be clickable/inspectable.
- Need to prototype whether review is inline, collapsible, tabbed, or embedded.

### Review agent environment

- Review agent may have its own Docker container.
- It should be able to inspect the committed work.
- It may start the same dev server and run tests.

### Open questions

- How to handle review-agent crashes or retries?
- How much duplicate work is acceptable between implementation and review agents?
- Should review be used only internally, or also for external commits/PRs?

## 19. Models and Thinking Modes

The UI prototype should support:

- Choosing a model.
- Choosing a thinking/reasoning mode.
- Possibly project-specific defaults.
- Possibly task-specific overrides.

## 20. Secrets and Credentials

### Principle

Minimize credentials available inside workspaces.

### AI inference credentials

- Stay in Atelier / the workspace manager.
- Not exposed to containers.

### Git credentials

Preferred:

- Agents do not get write credentials.
- Agents commit locally.
- Atelier merges/pushes.
- Agents may receive read-only credentials for private repos through the internal Git server.

### Deploy credentials

- Do not give deployment credentials to agents initially.
- If deployment is needed, prefer GitHub Actions or external deployment pipeline after push.

## 21. Project Configuration

Projects may need configuration for:

- Repository URL(s).
- Default branch.
- GitHub mirror settings.
- Clone/reference settings.
- LFS behavior.
- Default model/thinking mode.
- Dev-server command and port.
- Expected preview dimensions.
- Test commands.
- Review prompt augmentations.
- Special files/contracts to pay attention to during review.

## 22. Deployment and Project Operations

Deployment automation is probably later-stage.

Initial fallback:

- Merge into canonical repo.
- Push to GitHub.
- Let GitHub Actions or existing deployment systems handle deployment.

Future possibility:

- Project mission control UI for deploys, publish steps, Kubernetes changes, etc.

## 23. Continuous Cleanup / Improvement Ideas

Possible future workflows:

- Scheduled agents scan code for cleanup opportunities.
- Agents review recently landed code.
- Nightly improvement suggestions.

Concern:

- Prefer catching quality issues before merge via review agents rather than accepting bad code and cleaning later.

## 24. Suggested Implementation Phases

### Phase 1: UI prototype

- Project list/add project UI.
- New agent flow.
- Fullscreen agent page.
- Conversation history layout.
- Model/thinking selector.
- Basic result presentation.
- Diff/review mockups.
- Embedded dev-server preview mockup.
- File/artifact link mockup.

### Phase 2: Minimal backend

- TypeScript Atelier skeleton.
- Persistence layer.
- Project metadata.
- Start/stop Docker containers.
- Create cheap Git clones using host references.
- Run a simple agent loop using Pi libraries.
- Stream agent messages to UI.

### Phase 3: Files, terminal, preview

- Filesystem proxy URLs.
- Path-to-link conversion.
- Web terminal into container.
- Dev-server port proxy.
- Iframe browser preview.

### Phase 4: Commit/result workflow

- Prompt agents to commit work.
- Persist base commit and result commits.
- Diff viewer with commit range selection.
- Accept/merge button implemented by Atelier.
- Archive/stop container after merge.

### Phase 5: Review subagents

- Review button.
- Parent/subagent relationships.
- Review prompts.
- Feed review results back into implementation agent.
- Auto-review option.

### Phase 6: GitHub and durability polish

- GitHub mirror push/pull/webhooks.
- Better workspace recovery after Atelier restart.
- Workspace backing-container cleanup on startup.
- Fatal error handling.
- User accounts and merge permissions.

## 25. Key Open Questions

- Which TypeScript web framework best supports Rails-like server-rendered HTML plus dynamic streaming?
- How exactly should Atelier control Docker from inside its own container?
- What is the best Git LFS caching strategy?
- Should the Git server be embedded in the Atelier image?
- What URL/proxy scheme should be used for files and dev servers?
- How should rich HTML output from agents be sandboxed/rendered?
- What persistence format should agent histories use?
- How much state should survive deploys from day one?
- What should the first review-agent UI look like?
- How should project-specific prompts/configuration be stored?
