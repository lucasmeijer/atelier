# Atelier

Atelier is a workspace interface for collaborating with coding agents while inspecting and operating on the work they produce.

## Language

**Project**:
A reusable source and configuration from which multiple workspaces can be created.
_Avoid_: Workspace folder, repository

**Workspace**:
An isolated environment in which a user collaborates with agents and inspects or operates on their work. A workspace may be created from a Project or without one.
_Avoid_: Task, chat

**Projectless workspace**:
A workspace created without a Project and therefore without a reusable project source or configuration.
_Avoid_: Empty project, miscellaneous project

**Workspace pane**:
The collapsible navigation region for finding and switching between workspaces.
_Avoid_: Left sidebar, workspace tab

**Agent pane**:
The primary region for using the active Agent conversation in a workspace.
_Avoid_: Left tab, chat tab

**Agent conversation**:
An independently stateful transcript and composer for collaborating with an agent inside a Workspace. A Workspace may contain one or more Agent conversations, with one active at a time.
_Avoid_: Agent view, agent tab, chat, thread

**Work pane**:
The contextual region that slides in when needed to show files, changes, terminals, browsers, editors, and other working views.
_Avoid_: Right tab, preview tab

**Work view**:
A closable, reorderable tab inside the Work pane, such as a terminal, browser, File view, or Changes view. Only one Work view is active and visible at a time; Work views are not split into additional layout groups.
_Avoid_: Workspace group, preview group

**Resource Work view**:
A Work view representing an independently open resource or running session, such as a File, Browser, or Terminal view. It remains directly reachable while open.
_Avoid_: Document view, permanent view

**Contextual Work view**:
A workspace-level utility Work view, such as Changes, that is directly reachable on mobile while active and otherwise discovered through More.
_Avoid_: Permanent view, special view

**Mobile destination**:
A top-level phone navigation target for the Workspace pane, Agent pane, or an open Work view. Resource Work views remain destinations while open; a Contextual Work view is a destination only while active.
_Avoid_: Mobile tab, mobile Work pane

**More**:
The user-facing phone destination for finding Work views that are not currently top-level Mobile destinations. “Work” remains domain language and is not exposed as the name of this mobile affordance.
_Avoid_: Work, overflow

**Work view reference**:
A stable, type-bearing identity for one Work view. Generic Work pane actions accept any Work view reference, while type-specific actions accept only references of their own kind.
_Avoid_: Tab key, untyped view ID

**Unavailable Work view**:
A persistent Work view whose referenced resource cannot currently be loaded. It remains visible as an explicit unavailable state until its resource returns or the user closes it.
_Avoid_: Broken tab, missing tab

**Terminal view**:
A Work view connected to a terminal session. It either owns a session created specifically for it or attaches to an independently existing session.
_Avoid_: Terminal tab

**Owned terminal session**:
A terminal session created specifically for one Terminal view and governed by that view's lifecycle.
_Avoid_: Attached session

**Attached terminal session**:
A pre-existing terminal session surfaced through a Terminal view while retaining a lifecycle independent of that view.
_Avoid_: Owned session

**Attention request**:
A persistent, repeatable signal from an agent asking the user to inspect a particular Work view. It activates and reveals that view, clears when the view becomes visible, and may be requested again later.
_Avoid_: Work view unread, highlighted tab

**Agent ready**:
A persistent workspace-level status indicating that an Agent conversation has completed work whose newest assistant response has not yet been reached. Following the response to its tail, reaching the transcript bottom later, or viewing the beginning of the latest assistant message clears it; only Agent conversations contribute to this status.
_Avoid_: Workspace unread, workspace ready

**Changes view**:
A review-only Work pane view for inspecting files changed in a workspace and reading their diffs. A workspace has at most one open Changes view.
_Avoid_: Git client, source control panel

**File view**:
A Work pane view for reading one workspace file. A file has at most one open File view within a workspace.
_Avoid_: File tab, editor tab

**File navigator drawer**:
A contextual drawer inside a File view that reveals the workspace file tree. The Changes view reuses this navigation pattern with a Git-status-filtered file list.
_Avoid_: Directory browser thing, file sidebar

**Persistent Work view state**:
The server-restorable identity, order, and type-specific resource state of an open Work view. Its durability follows the view type rather than whether the user or agent created it, and remains until the view is explicitly closed.
_Avoid_: Published workspace state, saved layout

**Personal navigation state**:
A browser-local record of the user's choices while navigating persistent Work views, such as the selected Work view, pane and drawer visibility, and scroll position. It may be restored by that browser but is not server-authoritative workspace state.
_Avoid_: Workspace state
