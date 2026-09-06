# Agent delegation and the Subagents module

`@atelier/subagents` owns delegation, not a general Agent plugin framework.
The web composition root (`apps/web/src/server/main.ts`) explicitly installs
`subagentsDelegation` with `configureAgentDelegation` before starting runtimes.
It installs nothing when the existing workspace-module configuration disables
Subagents. There is one optional integration: no registry, extension IDs,
registration order, setting merges, or chains of request transforms.

The Agent package does not import Subagents. Subagents depends on Agent's host
operations; only the application startup knows both implementations. Workspace
module discovery continues to assemble routes, Cable channels, OpenAPI paths,
Work views, commands, icons, controllers, and assets.

## The small set of supported interactions

- **Prepare a session:** one conversation-scoped preparation supplies delegation
  instructions, tools, optional inherited model/thinking settings, and history
  seeding. Explicit initial settings take precedence over inherited settings.
- **Attach a session:** the integration binds its peer and lifecycle listener.
  Session replacement releases the previous attachment without unbinding its
  successor. Construction and handoff failures release newly created bindings.
  Initial asynchronous settings finish before the peer is bound.
- **Adapt one request:** each Pi message conversion creates fresh state, retained
  through provider serialization and payload adaptation. Only after that succeeds
  is `prepared` called. Failure propagates. This records request preparation,
  **not** HTTP acceptance, inference success, or a read receipt. The host restores
  Pi's original callbacks on disposal.
- **Resolve conversations:** root tabs are checked first, then persisted delegated
  conversations. Routes, images, lazy details and Agent Cable use the same lookup.
- **Close versus unload:** explicit close stops and unloads the root, awaits tree
  closure, then permits archival. Plain unload releases the runtime without
  closing the tree or tombstoning conversation identity. Workspace removal awaits
  delegation shutdown before disposing runtimes. Failures remain visible.
- **Present delegation:** the integration supplies tool summaries/details and
  consumes its custom session entries. Other entries retain normal Agent handling.

The integration is trusted Pi-specific code. Its session and history access is
intentional, not a claim of plugin isolation. It must not replace host request
callbacks. Configuration happens at startup, not while sessions are running.

## Additive transcript data, not arbitrary projection

`AgentDelegationTranscript.snapshot()` returns only:

1. **Rows**, each with a stable key and ephemeral server-rendered body. Rows are
   independently timed or explicitly placed before/during a particular turn.
2. **Anchors**, associating communication IDs with tool calls or completed text.

Subagents never receives host transcript items. It cannot rewrite their contents,
reorder them, or create Working sections. Agent applies placement and resolves
anchors, including temporary live-turn identity, for snapshots, lazy details and
reveal requests. Anchors on host items are navigation metadata resolved during
rendering; invalidation does not replace streaming text/tools to update anchors.
The reveal endpoint renders the target before the client scrolls to it.

Live invalidation reconciles only contributed rows (content, removal and placement).
It does not diff the entire transcript. Working-section rendering uses the same
additive data. The host retains text pacing and snapshot-to-incremental delivery.
Render callbacks are ephemeral views, never persisted session entries.

## What stays inside Subagents

The coordinator, filesystem ledger, restart recovery, task paths, pinned Codex
tools/output schemas, fork policy, provider-specific envelopes, message delivery
accounting, tree streams, communication renderers and Stimulus controllers live
in `packages/subagents`. The coordinator retains its `save`/`peer` interface.

Root session paths and existing JSONL/delivery formats are unchanged. Child histories
and their ledger now live under `session-shares/<share-key>/subagents/<workspace-id>/`,
inside the existing read-only `/atelier/session-share` mount. Startup atomically
relocates older workspace-private Subagents directories before workspace deletion
can remove them. Conflicting old/new stores fail rather than being merged.
Older delivery entries without `recipient` still resolve it from the durable routing
ledger; missing evidence is an error, not an invented recipient. No new configuration
or mount is added.

Newly prepared root sessions record a `subagent_history` custom entry containing a
share-relative directory and root ID. `SUBAGENTS.md` in the share also explains lookup
from older root filenames without that entry: select ledger agents by `rootId`, then
read `<id>.jsonl` in the same directory. `parentId` preserves nested delegation. Files
survive root archival and workspace deletion, just like root history. Replacement
sessions reuse the root identity/tree; timestamps and tool-call IDs distinguish runs.
A child interrupted before its session was created may have only a ledger record.

## Disabling and validation

The existing generator option remains supported:

```sh
ATELIER_DISABLED_WORKSPACE_MODULES=@atelier/subagents bun run generate:workspace-modules
```

Without that workspace module, startup does not install delegation, and there are
no delegation tools, instructions, routes, views, controllers, CSS or tree channel.
Saved files remain; saved disabled Work views use the existing unavailable state.
Regenerate normally to restore the module. This is optional installation, not a
package-deletion guarantee: application startup explicitly imports Subagents.

Run `bun run check` and `bun run test`. Non-UI checks exercise close/unload/removal,
custom history handling, request-scoped adaptation and failure propagation, Cable
protocols, session bindings, and persisted delivery parsing. Per
`ui-testing-policy.md`, validate presentation manually in the running application.
