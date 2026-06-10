# Workspace list rework — idiomatic Turbo Streams / Stimulus

> **Status: implemented.** Registry lives in `apps/web/src/server/workspace-registry.ts`,
> broadcast hub in `stream-hub.ts`, layout state in `workspace-layout.ts`, routing/rendering
> in `app.ts` (with `main.ts` as the wiring layer). Open questions were resolved as:
> failed workspaces offer dismiss only; the delete safety check is kept; cross-user
> creation bumps the list for everyone.

## Goals

- One understandable source of truth for the workspace list on the server.
- Instant visual feedback for create / delete / select.
- Server-rendered HTML everywhere; Stimulus only for genuinely client-side behavior.
- Docker remains the persistent truth for which workspaces exist; the only persisted
  view-state is the per-workspace `lastActivityAt` timestamp.

## Diagnosis of the current implementation

1. No single source of truth: every render re-queries Docker, merges a separately
   persisted activity JSON file, and consults the in-memory `workspaceTabBusy` map.
2. Workspace id is derived from the container id, so a workspace doesn't exist until
   `docker run` returns → the `initializing_<uuid>` token-frame hack + `redirect`
   controller on create.
3. Selection (per-client state) leaks into server renders (`active` class, `selected`
   hidden inputs, `syncActiveWorkspaceRow()` patch-ups after every stream render).
4. Custom `EventSource` Stimulus controller JSON-decoding turbo-stream HTML instead of
   Turbo's native `<turbo-stream-source>`.
5. Delete flow is response-shape-driven, not state-driven; no immediate feedback on the
   trash click; blocked/force/select-next logic entangled in one endpoint.

## Target architecture

### 1. Server-side `WorkspaceRegistry` (single source of truth)

New module `apps/web/src/server/workspace-registry.ts` owning an in-memory ordered list:

```ts
type WorkspacePhase = "starting" | "ready" | "checking_delete" | "deleting" | "failed";

interface WorkspaceEntry {
  id: string;             // app-generated, NOT the container id
  title: string;
  phase: WorkspacePhase;
  lastActivityAt: number; // drives sort order (desc)
  error?: string;         // phase === "failed"
}
```

- Boot: seed from `docker ps`. Transient phases don't survive a restart; every live
  container re-derives `ready`.
- Persistence: only `lastActivityAt`, in the existing
  `view-state/workspace-activity.json` file.
- All mutations go through registry methods (`add`, `setPhase`, `setTitle`, `touch`,
  `remove`, `setTabBusy`); each method emits exactly the right broadcast. Endpoints and
  event handlers never call `broadcastTurboStream` directly.

### 2. Decouple workspace id from container id

In `packages/core/src/workspace.ts`:

- `createWorkspace()` accepts a pre-generated short id; container started with
  `--name atelier-<id>` and label `com.atelier.workspace-id=<id>`.
- `listWorkspaces()` reads the id from the label/name.
- Result: `POST /workspaces` can register the entry and respond before `docker run`
  completes.

### 3. Lifecycle flows as state transitions

**Create** (`POST /workspaces`):
1. Generate id, `registry.add({ phase: "starting", lastActivityAt: now })` → broadcast
   puts the row (spinner, non-selectable) at the top of everyone's list instantly.
2. Respond `303 → /workspaces/<id>`; detail page renders a "workspace is booting…"
   placeholder. Correct URL from the first moment; no token frames, no redirect
   controller.
3. Async `docker run` + default agent setup. Success → `setPhase("ready")` (broadcast
   replaces row + detail placeholder). Failure → `setPhase("failed", error)`.

**Delete** (`POST /workspaces/<id>/delete`):
1. Stimulus on `turbo:submit-start` swaps trash → spinner; row gets `pending-delete`
   class blocking re-selection (optimistic, client-only).
2. Server sets `phase: "checking_delete"` → broadcast (row pending/unselectable for all
   clients).
3. Safety check runs while the form submission is pending:
   - Blocked → `setPhase("ready")` (broadcast restores row) and respond to the requester
     only with a turbo-stream appending the "uncommitted changes" modal. Force button
     posts `?force=1` (re-enters at step 2, skips the check).
   - Allowed → `setPhase("deleting")` (broadcast), `docker rm -f` runs async, respond
     with an ack stream.
4. On container removal → `registry.remove(id)` → broadcast removes the row. The
   residency host notices its active resident vanished and shows the empty-detail
   state. Deselection is a client reaction to row removal, not server-orchestrated
   `selected=1` plumbing.

**Title / busy:** registry `setTitle` / `setTabBusy` → single-row replace broadcast.
Busy does not reorder; only `workspace_user_activity` does (server-side recency;
no client/cookie hybrid — single-user focus).

### 4. Broadcast strategy — two granularities only

- Row change (phase, title, busy):
  `<turbo-stream action="replace" target="workspace_row_<id>">`.
- List change (membership or order): re-render the `workspaces_table_rows` container.
  Optional refinement: Turbo 8 `action="morph"` / `data-turbo-permanent` on the
  title-edit frame so an in-progress rename survives a reorder.

Broadcast HTML never contains per-client state: no `active` class, no `selected`
inputs. Rows render identically for everyone.

### 5. Transport: native `<turbo-stream-source>`

Replace `WorkspaceEventsStreamController` with:

```html
<turbo-stream-source src="/workspace-events/stream">
```

SSE endpoint changes from `data: <json-encoded html>` to plain multi-line `data:`
framing with raw turbo-stream HTML. Keepalive comments stay.

### 6. Client-side selection

One `workspace-list` Stimulus controller owns the `.active` class:

- Derives active id from `location.pathname` (and from residency activation).
- Re-applies after stream renders via a `turbo:before-stream-render`-adjacent listener
  (replaces scattered `syncActiveWorkspaceRow` calls).
- Marks rows with `phase != ready` as inert (no select, no delete re-click).

`workspace-residency` (hot-resident cache) stays as-is; gains one method to react when
its active resident's workspace is removed.

### 7. Tabs & groups

- Keep `workspaceLayouts` as in-memory, non-persistent server state, rebuilt by module
  attachment (`attachToWorkspace`) inspecting the container on boot.
- No cross-user live sync for layout changes; targeted `replace` of
  `workspace_groups_<id>` to the requester only, as today.
- Move the layout map + endpoints out of `main.ts` into `workspace-layout.ts`;
  `main.ts` becomes routing only.

### Stimulus controllers after the rework

- Keep: workspace-tabs, workspace-groups, workspace-residency, modal, modal-opener,
  global-filter, workspace-title-edit, terminal/agent/health.
- Delete: redirect, workspace-events-stream, remove-workspace-resident, activate-tab
  (fold into residency).
- Add: workspace-list (selection + pending-delete feedback; absorbs
  `syncActiveWorkspaceRow`).

## Implementation order

1. Core: app-generated workspace ids (`createWorkspace(id)`, label-based
   `listWorkspaces`). Independently shippable.
2. Registry: build `WorkspaceRegistry`, seed from Docker on boot, route all reads and
   broadcasts through it (behavior-neutral refactor).
3. Transport: SSE payload framing change, `<turbo-stream-source>`, delete the custom
   controller.
4. Selection cleanup: strip `active`/`selected` from server renders; new
   `workspace-list` controller.
5. Create flow: starting-phase rows + booting detail placeholder; delete token-frame +
   redirect machinery.
6. Delete flow: phase-driven pipeline (`checking_delete` → modal-or-`deleting` →
   removal broadcast); client-side deselection reaction.
7. Extract layout module from `main.ts`.

## Tests

Keep it lean: the registry is the new heart of the system, so concentrate unit tests
there (pure in-memory, no Docker, fast). Core changes extend the existing
Docker-backed integration tests in `packages/core/test/workspace.test.ts`. A handful of
HTTP-level tests pin the broadcast/response contracts so future refactors of the
rendering don't silently break the streaming behavior. No browser/E2E tests for now.

### Core (extend `packages/core/test/workspace.test.ts`, real Docker)

1. `createWorkspace(id)` uses the supplied id: container is named `atelier-<id>`,
   carries the workspace-id label, and `listWorkspaces()` returns that id.
2. Backward compat / reconciliation: a container without the new label (or with a
   foreign name) is still listed correctly — or explicitly excluded; pin whichever
   behavior we choose.

### `WorkspaceRegistry` unit tests (new `apps/web/test/workspace-registry.test.ts`, no Docker)

Inject a fake "docker" listing and capture emitted broadcasts; assert on entries and
on which broadcast granularity (row vs list) was emitted.

3. Boot seeding: registry seeds from the injected container list; all entries `ready`;
   ordering follows persisted `lastActivityAt`, unknown workspaces sort last.
4. `add` inserts a `starting` entry at the top and emits a list broadcast.
5. Phase transitions: `starting → ready` and `starting → failed` emit a row broadcast;
   illegal transitions (e.g. `deleting → ready`) throw or are ignored — pin the choice.
6. `touch` reorders (and persists `lastActivityAt`) and emits a list broadcast only
   when the order actually changes; touching the already-top entry emits nothing.
7. `setTabBusy`: busy aggregation per workspace (any busy tab ⇒ busy row), emits row
   broadcast on change only, and never reorders.
8. `remove` deletes the entry and emits the row-removal broadcast; removing an unknown
   id is a no-op.

### HTTP contract tests (new `apps/web/test/web.test.ts`, run server with fake/seeded registry)

These pin the wire contracts, not the markup details — assert on stream `action`/
`target` and key markers (phase class, absence of `active`), not full HTML.

9. `POST /workspaces` responds `303 → /workspaces/<id>` immediately (before container
   creation finishes) and the broadcast contains a `starting` row prepended to
   `workspaces_table_rows`.
10. Delete blocked: `POST /workspaces/<id>/delete` on a workspace with safety issues
    responds (requester-only) with a stream appending the confirmation modal, and the
    row phase returns to `ready` via broadcast.
11. Delete allowed/forced: phase goes `checking_delete → deleting`, and on completion
    the broadcast removes `workspace_row_<id>`.
12. Broadcast purity: rendered row/list broadcast HTML never contains `active` classes
    or `selected` inputs (regression guard for the per-client-state rule).
13. SSE framing: `/workspace-events/stream` emits raw turbo-stream HTML in plain
    multi-line `data:` lines (parseable by `EventSource` semantics), not JSON.

### Deliberately not tested

- Stimulus controllers (selection class juggling, optimistic spinners) — thin DOM glue,
  cheaper to verify manually than to maintain a browser harness for.
- Tab/group layout endpoints — existing behavior, unchanged by this rework; add tests
  only if the extraction to `workspace-layout.ts` changes behavior.

## Open questions

- `failed` phase UX: retry or just dismiss? (Plan assumes dismiss.)
- Keep the delete safety check? Plan keeps it; the phase machine makes removing it a
  one-line change (skip `checking_delete`).
- Another user creating a workspace bumps it to the top of your list (creation sets
  `lastActivityAt`). Assumed acceptable.
