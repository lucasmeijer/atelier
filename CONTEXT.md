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

**Parked workspace**:
A retained Workspace set aside from active use while remaining associated with its Project. Activity requiring user attention automatically unparks it.
_Avoid_: Archived workspace, inactive workspace

**Workspace pane**:
The collapsible navigation region for finding and switching between workspaces.
_Avoid_: Left sidebar, workspace tab

**Agent**:
A coding collaborator that acts through an Agent conversation.
_Avoid_: Agent conversation, Agent session

**Agent pane**:
The primary region for using the active Agent conversation in a workspace.
_Avoid_: Left tab, chat tab

**AgentPaneComposer**:
The composer in an Agent pane for continuing its active Agent conversation and selecting the model, thinking level, and service tier used for subsequent Agent work.
_Avoid_: Agent composer, in-pane composer, prompt box, chat input

**LaunchComposer**:
The composer used before a Workspace exists to provide its Agent’s initial prompt and select the model, thinking level, and service tier with which the Workspace starts.
_Avoid_: Launch form, launch prompt, new-workspace composer

**Agent conversation**:
An independently stateful transcript and AgentPaneComposer for collaborating with an Agent inside a Workspace. A Workspace may contain one or more Agent conversations, with one active at a time.
_Avoid_: Agent, Agent view, agent tab, chat, thread

**Agent session**:
The replaceable interaction history backing an Agent conversation. Replacing an Agent session retains the identity of its Agent conversation.
_Avoid_: Agent, Agent conversation

**Work pane**:
The contextual region that slides in when needed to show files, terminals, browsers, editors, and other working views.
_Avoid_: Right tab, preview tab

**Work view**:
A closable, reorderable destination inside the Work pane, such as a Terminal, Browser, File, or Files view. Only one Work view is active and visible at a time; Work views are not split into additional layout groups.
_Avoid_: Workspace group, preview group

**Resource Work view**:
A Work view representing an independently open resource or running session, such as a File, Browser, Terminal, or VS Code view.
_Avoid_: Document view, permanent view

**Contextual Work view**:
A workspace-level utility Work view, such as Files.
_Avoid_: Permanent view, special view

**Mobile destination**:
A top-level phone navigation target for the Workspace pane, an open Agent conversation, or a Work view configured for direct mobile access. Every open Agent conversation is directly reachable. Open File, Browser, and Terminal views are directly reachable; Files and VS Code views are found through More.
_Avoid_: Mobile tab, mobile Work pane

**Atelier bar**:
The phone-only bottom navigation bar for controls whose scope is Atelier rather than the selected Workspace. It is visible while the Workspace pane is visible, occupies the full bottom edge, and replaces the Workspace bar. When hidden, only the Workspace pane button remains visible at the bottom-left.
_Avoid_: Application bar, global bar, Workspace pane bar

**Workspace pane button**:
The phone control that remains at the bottom-left while the Atelier bar is hidden. Activating it opens the Workspace pane and reveals the Atelier bar.
_Avoid_: Atelier button, open button

**Workspace bar**:
The phone-only bottom navigation bar containing Mobile destinations within the selected Workspace, such as Agents, Browser, Review, and More. It is visible while the Workspace pane is hidden and is replaced by the Atelier bar when the Workspace pane opens.
_Avoid_: Current Workspace toolbar, resident bar

**Next unread**:
An Atelier navigation action that opens the oldest Workspace needing attention. It uses the same queue and ordering as the global keyboard command, including both Workspace unread and other Workspace-level reasons for attention.
_Avoid_: Next Agent, next Attention

**More**:
The user-facing phone destination that opens a bottom sheet with separate sections for Work views not configured for direct mobile access and launchers that create or reveal Work views. Singleton utility launchers such as Files remain available when their live Work views are closed. Selecting a Work view from More leaves the stable bottom destination bar unchanged, and More remains highlighted while a secondary Work view is visible. “Work” remains domain language and is not exposed as the name of this mobile affordance.
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
A persistent, repeatable signal asking the user to inspect a particular Work view in the requesting agent's own Workspace. A presentation operation may request attention for its target Work view. The request clears when its target Work view becomes visible and may be requested again later; a request made while its target is already visible is acknowledged immediately. Agent conversations do not receive Attention requests, agents cannot request attention across Workspaces, and Work-view Attention does not appear on Workspace rows.
_Avoid_: Fresh data, Work view unread, highlighted tab

**Agent ready**:
A state indicating that an Agent conversation has completed work whose newest assistant response has not yet been read. It contributes only to Workspace unread and is not shown as an Attention request or Agent-conversation indicator.
_Avoid_: Agent attention, Agent unread

**Workspace unread**:
A Workspace-level status set when one of its Agent conversations completes while the Workspace is not selected. Selecting the Workspace clears the status; Agent completion does not set it while the Workspace is selected.
_Avoid_: Workspace attention, Workspace ready

**File view**:
A Work pane view for reading and, when writable, editing one Workspace file. A file has at most one open File view within a Workspace.
_Avoid_: File tab, editor tab

**Persistent Work view state**:
The server-restorable identity, order, and type-specific resource state of an open Work view. Its durability follows the view type rather than whether the user or agent created it, and remains until the view is explicitly closed.
_Avoid_: Published workspace state, saved layout

**Personal navigation state**:
A browser-local record of the user's choices while navigating persistent Work views, such as the selected destination, pane and drawer visibility, Work-pane width, and scroll position. It may be restored by that browser but is not server-authoritative workspace state.
_Avoid_: Workspace state
