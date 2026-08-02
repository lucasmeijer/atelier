# Codex app reference patterns for Atelier

Date: 2026-07-30

Wayfinder ticket: [#8](https://github.com/lucasmeijer/atelier/issues/8)

Map: [#1](https://github.com/lucasmeijer/atelier/issues/1)

## Conclusion

Atelier should borrow Codex's separation between an agent conversation and contextual work, its thread-scoped Work-view tabs, and the shared navigation grammar behind workspace files and repository changes. It should not copy Codex's complete panel system or treat its desktop geometry as a mobile specification.

The strongest destination is therefore:

- keep the Workspace pane and Agent pane as Atelier's stable shell;
- make the right-side Work pane independently revealable and hideable;
- put File views, Changes, terminals, and browsers in one thread/workspace-scoped tab strip;
- keep File views and Changes as separate view types that share a file-tree component;
- use a dedicated single-surface mobile navigation model, with mobile-native Files and Changes flows;
- borrow Codex's compact dark hierarchy and restrained motion as a visual reference, without copying exact tokens or introducing its optional bottom panel.

## Evidence method

This report deliberately separates three evidence classes:

- **Documented fact** means a behavior stated by OpenAI in the current Codex manual, product documentation, changelog, or launch material.
- **Direct observation** means a behavior or styling detail inspected in the locally installed Codex desktop build `26.721.41059` on 2026-07-30. These observations are useful design evidence, but they are not a public compatibility contract.
- **Atelier inference** is a proposed design direction derived from the evidence and the destination already recorded in `CONTEXT.md` and ADR 0001.

The [current Codex manual](https://developers.openai.com/codex/codex-manual.md) was fetched first through the OpenAI docs helper. Its relevant source pages were the Codex changelog, code-review guide, browser guide, remote-connections guide, projects guide, integrated-terminal guide, and app commands. Only first-party OpenAI sources were used.

## 1. Shell and pane structure

**Documented facts.** OpenAI introduced the Codex app as a desktop interface with a project sidebar, thread list, and review pane, built for parallel agent threads organized by project. The current desktop product keeps developer details such as Git, diffs, review, and pull-request context visible. Later releases added workspace file tabs to the thread side panel and made terminals placeable in either a right or bottom panel. [Codex app launch](https://openai.com/index/introducing-the-codex-app/), [desktop comparison](https://learn.chatgpt.com/docs/use-chatgpt#compare-chatgpt-work-and-codex-on-desktop), [April 10 app release](https://learn.chatgpt.com/docs/changelog#codex-2026-04-10-app), [June 1 terminal placement release](https://learn.chatgpt.com/docs/changelog#codex-2026-06-01-app)

**Direct observations.** The current app shell has an independently toggled right side panel with a tab list and an optional bottom panel. Its new-tab affordance can offer Review, Terminal, Browser, Files, Detail, side chat, and context-provided tools. The conversation remains present when the side panel opens. The right panel has an explicit close/toggle control; opening or hiding it changes the spatial emphasis rather than changing the active thread.

**Atelier inference.** Adopt the conversation-plus-contextual-work relationship, but simplify it to Atelier's role-fixed Workspace, Agent, and Work panes. The Work pane should slide in and out without recreating its live views. Do not adopt Codex's optional bottom panel or allow tools to choose among multiple panel targets; ADR 0001 intentionally trades that flexibility for a stable model.

The public documentation does **not** establish “Agent always left, all work always right” as a Codex invariant. That geometry is an Atelier decision, inspired by the app rather than dictated by it.

## 2. Work-view tabs

**Documented facts.** Codex supports workspace file tabs in the thread side panel, drag-and-drop tab reordering, terminal tabs per thread, multiple terminals, and a setting that chooses whether terminals open in the right or bottom panel. The built-in browser is a shared human/agent view inside a chat, intended for previewing rendered work alongside the code diff. [April 10 app release](https://learn.chatgpt.com/docs/changelog#codex-2026-04-10-app), [April 12 app release](https://learn.chatgpt.com/docs/changelog#codex-2026-04-12-app), [Integrated terminal](https://learn.chatgpt.com/docs/integrated-terminal), [Browser preview](https://learn.chatgpt.com/docs/browser?surface=app#preview-a-page)

**Direct observations.** Right-panel tabs are typed rather than generic documents: Review, Browser, workspace File, terminal, and other tools retain their own controls and state. File-opening logic distinguishes a newly opened viewer from an already existing tab. Tab contents remain mounted as panel visibility changes, and the app has explicit state-preservation work for scroll position, review state, browser state, and embedded tool panels.

**Atelier inference.** Use one Work-view tab strip and make view identity explicit:

- one File view per canonical workspace path; opening the path again focuses that view;
- one Changes view per workspace;
- independently closable terminal and browser views;
- reorder on desktop, but no requirement for pointer-based reordering on mobile;
- no arbitrary split groups and no hidden “file versus review” mode inside a single tab.

The Work pane should preserve terminals, browser frames, unsaved editor state, and scroll positions while hidden, resized, or switched. Whether a view is restored by the server is a separate persistence decision; Codex's panel structure does not answer Atelier's published-versus-personal ownership question.

## 3. File views and the File navigator drawer

**Documented facts.** Codex added command-menu workspace file search, `Cmd+P` routing to that search, rich image/PDF/Markdown previews in its sidebar file viewer, and workspace file tabs in the thread side panel. [April 12 app release](https://learn.chatgpt.com/docs/changelog#codex-2026-04-12-app), [April 10 app release](https://learn.chatgpt.com/docs/changelog#codex-2026-04-10-app)

**Direct observations.** A workspace File tab starts as “Open file” until a path is selected. Inside the File view, a toolbar action toggles the workspace file tree; the app also exposes “Toggle File Tree” on `Cmd/Ctrl+Shift+E`. The tree includes root selection, text filtering, folder expansion, sticky folder rows, the active file selection, file-type icons, and “open in” actions. The selected file remains the primary content while the tree is revealed. The same low-level tree system supports Git-status decoration and filtered review files.

**Atelier inference.** This is the clearest reference for Atelier's File view:

1. The file itself is the view's primary identity and content.
2. The File navigator drawer is progressive disclosure inside that view, not a permanent global file manager.
3. Selecting a different file creates or focuses that file's File view rather than silently changing the identity of the current tab.
4. Search and tree navigation are primary; upload, download, delete, and other management actions should be contextual.
5. Drawer visibility, expansion, selection, and scroll position are personal navigation state unless an agent explicitly publishes a file for review.

Codex's public docs do not specify the drawer side, dimensions, breakpoint behavior, deduplication contract, or persistence semantics. Atelier should validate those details in its File/Changes prototype.

## 4. Changes as a separate review view

**Documented facts.** Codex's review pane represents repository state, not merely files edited by the agent. It supports Unstaged, Staged, Commit, Branch, and Last-turn scopes. A file-row background expands or collapses its diff, while clicking the filename opens the source in the configured editor. The app supports inline comments tied to diff lines. Codex also exposes staging, reverting, committing, and pushing, but those actions are separable from its review information architecture. [Review scopes](https://learn.chatgpt.com/docs/code-review?surface=app#what-changes-it-shows), [Review navigation](https://learn.chatgpt.com/docs/code-review?surface=app#navigating-the-review-pane), [Inline comments](https://learn.chatgpt.com/docs/code-review?surface=app#inline-comments-for-feedback), [Git actions](https://learn.chatgpt.com/docs/code-review?surface=app#staging-and-reverting-files)

**Direct observations.** Review uses the same file-tree foundation as workspace Files, configured with Git statuses such as added, modified, deleted, renamed, and untracked. It adds review-specific decorations and selection. The diff surface shows file, addition, and deletion counts; supports unified and split presentation; supports rich previews; and lets individual file diffs collapse. Review and File tabs remain distinct even though they share navigation and rendering infrastructure.

**Atelier inference.** Keep Changes separate from File views, and reuse the navigator implementation rather than unifying the products:

- the Changes navigator is a workspace tree filtered to files with relevant Git status and annotated by that status;
- selecting a changed file stays in Changes and reveals its diff;
- “Open file” is an explicit action that focuses an existing File view or creates one;
- Changes is review-only: exclude staging, reverting, committing, branch management, conflict resolution, and push controls;
- start with the working-tree change set unless a later ticket establishes additional scopes as necessary.

This preserves the useful Codex relationship between file location and diff context while avoiding a hidden mode switch and the cognitive weight of a full Git client.

## 5. Visual hierarchy and density

Public OpenAI documentation does not provide a design-system specification for Codex's typography, spacing, color hierarchy, panel dimensions, or borders. The following points are therefore **direct observations**, not documented requirements:

- The current dark UI uses semantic surface, foreground, border, status, and chart tokens rather than component-specific literal colors.
- Hierarchy comes mostly from layered near-dark surfaces, restrained one-pixel borders, muted secondary/tertiary text, and hover/selected fills—not large cards or saturated decoration.
- Tool chrome is compact: common labels are around 14 px; toolbar icons are generally 16–20 px; list rows are commonly about 29–40 px; major compact headers are about 48 px.
- Controls usually reveal detail progressively through tooltips, menus, drawers, and tab-specific toolbars.
- File and review views give most of their width to content, while navigation and metadata remain visually subordinate.

**Atelier inference.** Borrow the relationships, not the numbers. Build the redesign in one dark semantic token set; use low-contrast surface layering, compact but touch-safe controls, and a strong primary-content area. Atelier should keep its own type, color, radii, and spacing decisions. Desktop density must loosen on touch layouts rather than carrying 29 px rows onto mobile.

## 6. Motion and state continuity

**Documented facts.** Codex release notes repeatedly treat preserved state as product behavior: thread scroll position persists per conversation; review refresh preserves diff/search state; embedded panels avoid restarting during full-screen or reload transitions. This supports continuity as a higher-order requirement than animation polish. [April 9 app release](https://learn.chatgpt.com/docs/changelog#codex-2026-04-09-app), [April 20 app release](https://learn.chatgpt.com/docs/changelog#codex-2026-04-20-app), [April 24 app release](https://learn.chatgpt.com/docs/changelog#codex-2026-04-24-app)

**Direct observations.** The current build uses short transition tokens around 150 ms for basic changes and 300 ms for relaxed spatial changes, and includes reduced-motion handling. Panel opening/closing communicates where content came from; tab selection and review expansion are quieter and faster.

**Atelier inference.** Animate spatial causality, not every state change:

- slide the Work pane and navigator drawer over roughly 150–300 ms;
- keep tab activation immediate or nearly immediate;
- preserve the mounted view while it moves or hides;
- avoid layout bounce when diff counts, statuses, or asynchronous content update;
- honor `prefers-reduced-motion` by removing nonessential movement without hiding state changes.

Exact duration and easing remain prototype questions.

## 7. Small-screen and mobile analogues

**Documented facts.** OpenAI describes Codex on mobile as a fully featured Remote experience that loads live state from a host. Mobile can switch across threads, review outputs and diffs, see terminal output and screenshots, approve actions, and start or steer work. iOS separately added a workspace file browser, a directory picker, expand/collapse-all controls for changed-file diffs, line wrapping, and inline review comments. [Mobile product announcement](https://openai.com/index/work-with-codex-from-anywhere/), [Remote capabilities](https://learn.chatgpt.com/docs/remote-connections#what-you-can-do-remotely), [June 15 iOS release](https://learn.chatgpt.com/docs/changelog#codex-2026-06-15-mobile), [June 9 iOS release](https://learn.chatgpt.com/docs/changelog#codex-2026-06-09-mobile)

The docs describe capability parity through mobile-native flows; they do not define a desktop-to-mobile pane transformation. Detailed Files and Changes interactions in the release notes are specifically documented for iOS, while Remote support is described generally for iOS and Android.

**Atelier inference.** Do not shrink Workspace + Agent + Work into three narrow columns. Mobile should display one primary surface at a time:

- Agent is the default task surface.
- Opening a Work view navigates to or overlays a full-width work surface with an obvious return to Agent.
- Work-view switching uses a compact sheet, bar, or task switcher rather than a desktop-width tab strip.
- File navigation and changed-file navigation use full-height sheets/routes or in-view drawers sized for touch.
- Changes defaults to unified, wrapped diffs with per-file collapse; desktop may additionally offer split diffs.
- Core workflows retain parity, while drag reordering, hover controls, and simultaneous side-by-side inspection do not.

This is a deliberate responsive analogue, not a visual replica of Codex mobile.

## 8. Multiple agents: reference, not a resolved model

**Documented facts.** Codex's primary parallel-work model is separate agent threads organized by projects. Worktrees let those threads operate on isolated copies of the same repository. The product also allows inspecting subagent threads and has added stable identifiers and progress/status treatment for background subagents. [Codex app launch](https://openai.com/index/introducing-the-codex-app/#work-with-multiple-agents-in-parallel), [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [May 28 app release](https://learn.chatgpt.com/docs/changelog#codex-2026-05-28-app)

**Atelier inference.** Do not make agent threads into Work views. The Agent pane should continue to own whichever agent conversation is active, while the Workspace pane or a future agent-navigation layer handles movement among peers, same-workspace subagents, and child-workspace agents. Codex is useful evidence that thread identity and workspace identity are related but not identical; it does not resolve Atelier's still-open hierarchy.

## Adopt, adapt, and avoid

### Adopt

- Conversation as the stable primary surface, with contextual work revealed beside it.
- Thread/workspace-scoped typed tabs for files, review, terminal, and browser.
- File tree as progressive disclosure inside file work.
- Shared file-tree infrastructure configured differently for Files and Changes.
- Repository-driven change review with collapsible per-file diffs.
- Compact semantic dark hierarchy and state-preserving transitions.
- Mobile capability parity delivered through native small-screen navigation.

### Adapt

- Use only a right Work pane; fold Codex's right/bottom placement options into one Atelier rule.
- Turn Codex's general workspace File tab into one path-identified File view.
- Turn Codex's Git-capable review pane into a review-only Changes view.
- Increase touch targets and move tab/tree selection into sheets or routes on mobile.
- Treat exact timing, drawer geometry, tab overflow, and mobile switching as prototype outcomes.

### Avoid

- Carbon-copying Codex colors, dimensions, icons, or every piece of tool chrome.
- Bringing back arbitrary panel placement or layout groups.
- Combining File and Changes into one modeful view.
- Treating the mobile app as a squeezed desktop shell.
- Surfacing Git mutations in Changes.
- Freezing a multi-agent hierarchy before the agent/workspace relationship has its own decision ticket.

## Prototype acceptance questions

The desktop shell, mobile navigation, and File/Changes prototypes should answer these concrete questions:

1. Can users reveal and hide the Work pane without losing their place in Agent or any live Work view?
2. Is the active Work view and the pane's close/reopen behavior legible without persistent labels or tutorial text?
3. Does the File navigator drawer feel contextual to one File view while still making it quick to open another file?
4. In Changes, is selecting a diff versus explicitly opening the source file unambiguous?
5. Can mobile users move Agent → Work view → navigator → content → Agent with a short, reversible path?
6. Do dark hierarchy, compact density, and motion remain readable at desktop and touch sizes, including reduced motion?

## Source boundary

OpenAI's public sources establish concepts and supported workflows, but not a reusable Codex visual specification. Exact pane dimensions, drawer direction, tab deduplication, persistence ownership, breakpoint thresholds, typography metrics, and animation curves should remain Atelier prototype decisions. The local build observations above are a dated reference snapshot, not a promise of future Codex behavior.
