# Coding assignment: replace Agent and Workspace loading/rendering

## Mandate

Replace the current Workspace residency, Workspace preparation, Agent-tab rendering, Agent live-update, and transcript positioning implementations as one coherent redesign.

This is a replacement, not an incremental compatibility layer. Delete the old machinery when its replacement works. Do not preserve old interfaces, migration fallbacks, live-node transplantation, cursor protocols, or synchronization hooks merely to reduce the size of the diff.

The authoritative product requirements are in:

- `agent_and_workspace_requirements.md`

Read that file completely before changing code. Where these instructions summarize behavior, the requirements file wins.

Also read and obey:

- `AGENTS.md`
- `docs/ui-testing-policy.md`

Use the codebase-design vocabulary and aim for deep modules: small interfaces that hide loading, ordering, and rendering complexity at clean seams.

## Outcomes

The finished system must have these properties:

1. A ready Workspace shell is rendered once and is never replaced for ordinary application mutations.
2. Agent tabs and Work views are added, removed, reordered, selected, and marked for attention with narrowly targeted Turbo Streams.
3. Workspace preparation fetches only the surfaces that would be visible when that Workspace opens.
4. Agent shell metadata is cheap; Agent bodies are rendered on demand through a dedicated endpoint.
5. Only logically visible Agent panes have live connections.
6. Every Agent connection starts with a complete authoritative snapshot followed by ordered incremental updates.
7. There are no Agent stream cursors, generations, revisions, resume positions, or client-side duplicate-cursor tracking.
8. The only client state guaranteed across reconstruction, refresh, and eviction is per-Agent composer content.
9. Transcript positioning and disclosure behavior match the requirements file.
10. The old residency, synchronization, shell replacement, and transplantation implementations are removed.

## Preserve the Work-view metadata/body seam

The recently introduced Work-view seam is directionally correct and is not the target of a broad redesign.

Keep the fundamental interface:

- modules contribute cheap `WorkspaceWorkViewPresentation` metadata;
- persisted Work views contain type-native references;
- a `WorkspaceModuleWorkViewAdapter` validates identity and renders the expensive body;
- Atelier loads the body from `/workspaces/:workspaceId/work-views/:key/body` through a Turbo Frame.

Do not combine Agent tabs and Work views into a generic surface abstraction. Their lifecycle and domain rules differ.

Change Work-view orchestration only where required:

- hydrate only the selected Work view when the Work pane is intended to be open;
- do not hydrate every Work view during Workspace preparation;
- convert close, reorder, attention, availability, and creation responses to targeted Turbo Streams;
- never replace the Workspace shell to update Work views;
- preserve the existing adapter interface unless a very small mechanical adjustment is necessary for the new orchestration.

## Introduce a two-phase Agent-tab seam

The current `WorkspaceAgentConversationPresentation.bodyHtml` design eagerly renders every Agent during Workspace attachment. Remove that behavior.

Introduce an Agent-tab provider interface with this conceptual shape:

```ts
interface WorkspaceAgentTabSummary {
  id: string;
  title: string;
}

interface WorkspaceAgentTabProvider {
  list(context: {
    workspaceId: string;
  }): Promise<readonly WorkspaceAgentTabSummary[]>;

  render(context: {
    workspaceId: string;
    conversationId: string;
  }): Promise<string>;

  close(context: {
    workspaceId: string;
    conversationId: string;
  }): Promise<void>;
}
```

The exact type placement may follow repository conventions, but preserve this division of responsibility.

### Provider rules

- `list` is cheap and must not render transcripts, calculate pane state, or initialize every Agent runtime.
- Agent identity is the immutable conversation ID.
- Titles are presentation metadata, not identity.
- `render` resolves the conversation ID and renders one authoritative Agent body.
- `close` archives that conversation and enforces the invariant that the last Agent cannot be closed.
- There must be one unambiguous Agent-tab provider for a Workspace. Fail clearly on conflicting providers rather than silently merging them.
- Remove Agent list/close pass-through methods from `WorkspacePresentationStore`; it should continue to own persisted Work-view presentation state, not act as a shallow Agent forwarding layer.
- Remove `agentConversations` with eager `bodyHtml` from `WorkspaceAttachment`.
- Workspace module commands remain the way to create Agents.

### Agent body route

Add an authoritative endpoint keyed by immutable identity:

```text
GET /workspaces/:workspaceId/agents/:conversationId/body
```

Atelier owns the matching Turbo Frame wrapper and stable frame ID. The provider owns the HTML inside the Agent pane.

The Workspace shell renders:

- cheap Agent tab controls from summaries;
- one stable pane slot/Turbo Frame per Agent summary;
- lazy body URLs;
- no eagerly rendered inactive transcripts.

Only the selected Agent body is hydrated during foreground loading or background Workspace preparation.

All Agent browser-facing identity at this seam—including the Agent Cable topic—must use `conversationId`, not the display label. A label may remain an internal session-store property where needed.

## Stable Workspace shell and targeted Turbo Streams

After the initial ready Workspace shell is rendered, ordinary events must never use `workspacePresentationTurboStream` or an equivalent full-shell replacement.

Create stable IDs for the structural regions that may change independently. At minimum, support targeted updates for:

- Agent header/tab navigation;
- individual Agent tab controls;
- individual Agent pane slots;
- Agent action controls;
- Work-view selectors;
- individual Work-view panes;
- Work-view ordering;
- Work-view availability;
- desktop and mobile Work-view destinations;
- Work-view close controls;
- attention indicators;
- command launcher regions.

One mutation may return several standard Turbo Stream operations. That is preferred over replacing a shared ancestor.

Use small custom Turbo Stream actions only for behavior that cannot be represented as markup mutation, such as:

- selecting a successor after the active Agent or Work view closes;
- recording the intended selected Work view and opening the Work pane when a hidden Workspace receives Work-view attention;
- presenting a newly created Work view.

### Required mutation conversions

Convert all current full-presentation refresh paths, including:

- Agent creation;
- Agent close;
- Work-view creation/open;
- Work-view close;
- Work-view reorder;
- Work-view attention request;
- Work-view attention acknowledgement;
- Agent-driven Work-view presentation;
- availability/action changes that currently rebuild the presentation.

Mutations must converge across connected browsers, not just in the initiating response. Avoid duplicate tab/pane insertion when both a direct response and a broadcast reach the same browser.

Adding a second Agent may replace the isolated Agent-navigation header region, but it must not replace existing Agent bodies. Removing an Agent removes only that Agent’s controls and pane.

A provisioning placeholder may be replaced by the first ready Workspace shell. Workspace deletion and full-document navigation remain lifecycle exceptions.

## Delete live-node transplantation

Remove the entire live-node preservation protocol:

- `preserveLiveKeys`;
- `data-workspace-live-node` and `data-workspace-live-slot`;
- `replace-workspace-presentation`;
- `moveNodeBefore` transplantation;
- stopping and restarting the Stimulus application around replacement;
- code that computes preservation sets at mutation call sites;
- tests that require object/iframe identity through whole-presentation replacement.

Do not replace this with another transplantation or morphing scheme. Unrelated live surfaces survive because their ancestors are not replaced.

## Replace Agent cursor synchronization with snapshot-first live connections

### User-visible lifecycle

An Agent pane opens a live connection only when all are true:

- its Workspace is selected;
- its Agent tab is selected;
- the Agent surface is logically visible in the current responsive layout;
- the document is visible;
- its body has loaded.

Disconnect when any condition becomes false. In particular:

- disconnect on Workspace switch;
- disconnect on Agent-tab switch;
- disconnect on mobile when navigating from Agents to a Work view;
- disconnect when the document becomes hidden;
- disconnect when the pane is removed, reloaded, or evicted.

On desktop, opening the Work pane does not disconnect the Agent because both remain visible. Temporary dialogs, overlays, or fullscreen surfaces do not change logical Agent selection.

Workspace preparation never connects hidden Agent panes. Workspace-level busy, ready, and attention status continues through the lightweight shell/registry update path.

Atelier must explicitly notify panes of logical visibility. Remove the current pattern in which several layers independently infer visibility from DOM classes and each try to start or stop the Agent.

### Snapshot-first protocol

For every initial Agent subscription and every reconnection:

1. keep/show the existing prepared transcript if one exists;
2. mark it reconnecting when appropriate;
3. server-send one complete authoritative update for Agent-owned authoritative regions;
4. apply that update;
5. deliver every subsequent incremental Agent update in order.

The authoritative subscription update may replace:

- transcript;
- busy/send/stop state;
- stats;
- model and thinking controls.

It must not replace or clear:

- composer text;
- attachment chips/references;
- the Agent pane slot;
- sibling Agent tabs;
- the Workspace shell.

The server-side Agent live interface must guarantee that the initial authoritative update is ordered before every later incremental update, with neither a gap nor duplication. Put the required serialization inside the Agent runtime/live-presentation module. Do not expose that mechanism to Atelier callers.

A suitable deep interface is one operation that subscribes a listener and guarantees that its first delivery is an authoritative snapshot and all later deliveries are incremental updates. The precise implementation is up to the coding agent, but its ordering contract must be explicit and tested.

On reconnect, do not replay missed DOM updates. Send current authoritative state and continue from there.

### Remove cursors everywhere

Delete:

- Agent `snapshotGeneration` and `snapshotRevision` state;
- `snapshotCursor` rendering and Stimulus values;
- `upTo` subscription arguments;
- cursor fields in Cable client/server messages;
- `knownCursors` and cursor comparison in the client;
- `cableCursorIsNewer`;
- cursor-aware `snapshotStream` behavior;
- synchronization promises based on cursor confirmation;
- tests for cursor resume/deduplication.

WebSocket ordering within one connection and the snapshot-first subscription contract replace these features.

A simple callback after the initial authoritative delivery may remain for local connection-ready UI, but it must not participate in Workspace preparation or cursor synchronization.

## Rewrite Workspace residency and preparation

Replace `WorkspaceResidencyController` and the generic `onSynchronizeWorkspace` hook with a small, explicit Workspace-residency/preparation module.

### Resident policy

- Retain at most five complete Workspace residents, including the visible resident.
- Run at most one background preparation at a time.
- Never evict the visible Workspace.
- Prefer retaining unread-ready prepared Workspaces over read/inactive Workspaces.
- Among unread-ready Workspaces, retain oldest-ready first.
- Among other inactive Workspaces, retain most recently used first.
- Eviction destroys rendered Workspace/Work-view state but never composer state.

### Preparation queue

Build and maintain the queue from shell/registry metadata:

- readiness immediately makes a Workspace unread;
- existing unread-ready Workspaces are queued on startup;
- process oldest-ready first, using the same ordering as the “open oldest unread Workspace” command;
- foreground selection always outranks background work;
- if foreground selection targets a queued/in-flight preparation, reuse and promote that operation;
- rows beyond preparation capacity still show unread normally;
- only a Workspace actively being prepared may temporarily replace its unread indicator with a spinner;
- when preparation ends or stops, restore unread display if still unread.

Do not hide unread state until preparation completes.

### Preparing one Workspace

Preparation means:

1. fetch or reuse its resident shell;
2. restore its intended personal navigation state;
3. load/reload the selected Agent body authoritatively;
4. if the Work pane is intended to be open, hydrate only the selected Work view;
5. wait for those intended visible surfaces to finish initializing;
6. mark that resident prepared without making it visible or acknowledging attention.

Do not fetch inactive Agent bodies or inactive Work-view bodies.

A previously foreground-loaded Workspace may count as prepared while retained. A known relevant mutation invalidates its prepared state. Avoid inventing a general client revision/cursor system; respond to explicit mutation events and re-prepare when the Workspace is eligible.

If Work-view attention is requested for a hidden Workspace:

- update its intended selected Work view;
- set its intended Work pane to open;
- do not visibly switch the current Workspace;
- do not acknowledge attention;
- include that Work view in preparation.

Agent completion does not switch the hidden Workspace’s selected Agent tab.

### Foreground navigation

- Change the URL immediately.
- Make the previous Workspace inaccessible while an unprepared destination loads.
- Latest selection wins over older pending selections.
- Back and Forward use the same selection/preparation path as row clicks.
- A failed background preparation falls back to a normal foreground load.
- Full refresh restores Workspace, Agent selection, Work-pane state, selected Work view, and composer content—not rendered DOM or scroll position.

## Composer durability

Composer state belongs to `[workspaceId, conversationId]`, not to a rendered form or randomly generated body render.

Implement these guarantees:

- persist text on every edit in browser-local durable storage;
- restore text whenever that Agent body is reconstructed;
- use a stable per-Agent attachment-draft identity rather than generating an unrelated draft on every render;
- keep completed uploads server-side until successful send or explicit removal;
- clear text and attachments only after the server successfully accepts the message or the user explicitly discards/removes them;
- failed submissions, navigation, reconnect, Agent reload, Workspace eviction, and browser refresh do not clear content;
- no cross-browser text synchronization is required;
- no sophisticated interrupted-upload resume behavior is required.

Composer durability must not depend on preserving the old composer DOM node.

## Transcript behavior

Implement all transcript requirements from the requirements file, including:

### Selection positioning

Never restore prior transcript scroll position.

When an Agent becomes visible or receives its initial authoritative subscription update:

- if working, follow the tail;
- if not working, place the beginning of the latest user message at the top of the transcript viewport, bounded by the available range.

### Manual scrolling while streaming

- follow the tail while the user remains near it;
- if the user scrolls into history, stop following;
- new output and layout changes must not pull them back;
- resume following only when the user returns near the tail.

### Transcript navigation control

Keep the control near the composer, but change its destination to the beginning of the latest user message.

- indicate whether that destination is above or below the viewport;
- disable the control when already at its destination;
- while the Agent is working, invoking it counts as leaving the tail and streaming must respect that choice.

### Working disclosures

- current Working section and its tool calls initially render open;
- only the current turn auto-opens;
- respect manual collapse for the remainder of the rendered session;
- collapse the Working section and tool calls when final assistant text begins streaming;
- completed work renders collapsed after authoritative reconstruction;
- completed details remain manually openable and may load lazily;
- use targeted active-region updates so routine streaming does not reset disclosure choices.

Remove old historical-disclosure restoration machinery that exists solely to survive full transcript/pane replacement. Disclosure state is not durable across authoritative reconstruction.

## Remove obsolete client hooks and palette behavior

Remove or simplify obsolete interfaces and implementation, including:

- `onSynchronizeWorkspace`;
- `synchronizeAgentResident`;
- Agent-pane `synchronize()` promises;
- redundant visibility inference/start calls;
- preload logic that starts hidden Agent subscriptions;
- preload logic that hydrates all Work views;
- Agent command-palette search based on retained Agent panes, busy state, or transcript-tail text.

Keep desktop automatic composer focus without page scrolling when an Agent becomes visible. Do not auto-focus on phone layouts.

## Preserve unrelated behavior

This is a large replacement, but do not regress unrelated Agent features:

- sending, steering, and stopping;
- model and thinking controls;
- prompt history;
- slash/file completion;
- attachments after upload completes;
- lazy historical tool details;
- terminal tool views;
- fullscreen tool/media behavior;
- workspace creation, parking, deletion, commands, and automation JSON responses;
- responsive Agent/Work navigation.

Keep JSON/OpenAPI command behavior compatible unless identity migration to `conversationId` requires a deliberate schema correction.

## Testing strategy

Follow `/work/docs/ui-testing-policy.md`. Replace implementation-coupled tests rather than layering new expectations over obsolete ones.

### Fast tests

Add or update focused unit/server tests for:

- Agent provider `list` being metadata-only;
- rendering exactly one Agent by immutable conversation ID;
- Agent body route/frame contract;
- targeted Agent add/close streams;
- targeted Work-view close/reorder/attention streams;
- absence of full Workspace presentation replacement in ordinary mutations;
- snapshot-first subscription ordering under a deliberately interleaved Agent update;
- reconnect beginning with authoritative state and no cursor fields;
- preparation queue oldest-ready ordering;
- one-at-a-time background preparation;
- five-resident eviction policy;
- foreground promotion and latest-selection-wins behavior;
- visible-surface-only hydration;
- transcript selection positioning and tail-following calculations;
- composer storage keyed by immutable conversation identity.

### Browser tests

Use browser tests only for behavior requiring Turbo/Stimulus/browser lifecycle integration. Cover at least:

1. an unread Workspace is shown immediately, spins only while actively preparing, and opens without additional visible-surface requests after successful preparation;
2. preparation loads only the selected Agent and selected open Work view—not inactive tabs;
3. selecting during preparation adopts the existing request;
4. hidden Work-view attention opens/selects that Work view in intended navigation and preparation without changing the currently visible Workspace;
5. Agent live connection connects/disconnects on Workspace, Agent-tab, mobile-destination, and document visibility transitions;
6. reconnect applies authoritative transcript state and resumes streaming without replacing composer content;
7. composer text and completed attachments survive Agent switching, Workspace switching, Agent-body reload, eviction, and page refresh as applicable;
8. Agent add/close and Work-view mutations do not reload an unrelated visible Work surface;
9. nonworking Workspace selection positions the latest user message at the top;
10. working selection follows the tail, manual history scrolling pauses following, and the navigation button targets the latest user message;
11. active Working/tool disclosures open, respect manual collapse during streaming, and collapse when final text starts;
12. Back and Forward perform normal Workspace navigation.

Delete or rewrite tests for:

- cursor resume/deduplication;
- synchronization of cached hidden Agent panes;
- preloading every Work view;
- full-presentation replacement;
- live-node transplantation and iframe identity through shell replacement;
- transcript scroll-position retention;
- Agent palette search over retained panes.

Do not assert incidental markup or class structure. Test stable roles, destinations, stream targets, requests, visibility, and user-observable state.

## Verification and presentation

Before considering the assignment complete:

1. Run `bun run generate:workspace-modules` before raw TypeScript checks.
2. Run focused tests throughout the replacement.
3. Run `bun run check`.
4. Run `bun run test`.
5. Start the development server with `bun run web` in a tmux session on an allowed port.
6. Use the running Atelier instance and its advertised OpenAPI interface to create an immediately evaluable scenario containing:
   - several ready Workspaces ordered by age;
   - enough Workspaces to exercise the five-resident limit;
   - a Workspace with multiple Agent tabs;
   - a visible Work pane and attention-seeking Work view;
   - an actively streaming Agent;
   - a durable unsent composer draft.
7. Present the browser at that prepared scenario.
8. Summarize the architecture replacement, deleted machinery, verification results, and Git line diff totals.

## Completion checklist

Do not stop at a partially layered state. Completion requires all of the following:

- [ ] requirements file behavior is implemented;
- [ ] cheap Agent summary / lazy Agent body seam exists;
- [ ] immutable conversation IDs are used by Agent body routes and live topics;
- [ ] no ordinary mutation replaces a ready Workspace shell;
- [ ] targeted Turbo Streams cover Agent and Work-view mutations;
- [ ] no live-node transplantation remains;
- [ ] no Agent cursor protocol remains;
- [ ] snapshot-first live-update ordering is tested;
- [ ] hidden/preloaded Agent panes do not connect live;
- [ ] only intended visible surfaces are prepared;
- [ ] queue ordering, one-at-a-time preparation, and five-resident retention work;
- [ ] unread appears before preparation and spinner appears only during active preparation;
- [ ] composer state survives every required lifecycle;
- [ ] transcript scroll and disclosure behavior matches requirements;
- [ ] Agent retained-pane palette search is removed;
- [ ] obsolete synchronization hooks and tests are deleted;
- [ ] full check and test suites pass;
- [ ] the result is running and staged for evaluation.

