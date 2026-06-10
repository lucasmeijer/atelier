# Agent Tab Redesign Plan

A ground-up redo of the agent module's visual design and streaming implementation. We keep:

- **pi agent SDK** (`@earendil-works/pi-coding-agent`) as the agent runtime.
- **Bash execution inside the workspace Docker container** (via `execWorkspaceShell` / docker exec today, evolving to tmux-based PTY execution — see §6).
- The general atelier architecture: server-rendered HTML, Turbo Frames/Streams + Stimulus where it fits.

We throw away and rebuild: everything visual in the agent tab, the message streaming transport, the turn/section model, and the client controller (`packages/agent/src/client/agent-chat-controller.ts`, `server/render.ts`, the WS render-op protocol in `shared/protocol.ts`, and most of `server/runtime.ts`).

---

## 1. Core UI layout

- **Prompt box pinned to the bottom** of the agent tab at all times (sticky footer inside the tab pane, not the page).
- Messages render **above** the prompt box, newest at the bottom, flowing upward. When content exceeds the viewport, the transcript scrolls; the prompt box never scrolls away.
- Layout: a flex column — `transcript (flex: 1, overflow-y: auto)` + `prompt box (flex: none)`. Transcript auto-scrolls to bottom while streaming, with the standard "stop auto-scroll when the user scrolls up, resume on scroll-to-bottom / new user message" behavior (Stimulus controller).

### Prompt box (inspired by Codex prompt box + pi's console footer)

A bordered, multi-line, auto-growing textarea with:

- **Stats row** (the things pi's TUI footer shows):
  - context window usage as a percentage (with a subtle meter),
  - session cost ($),
  - tokens up / tokens down (input/output, possibly cache read/write on hover),
  - current model + provider.
  - Data source: pi session/agent usage events; the server pushes stat updates over the same SSE stream as messages (see §3) and the prompt box updates a small Turbo-Frame-like region or Stimulus targets.
- **Selectors**: provider, model, and thinking level. Server-rendered `<select>`s (or a small popover menu) populated from pi's `ModelRegistry`; changing them POSTs to the server which calls the corresponding session API. No client-side model list logic.
- **Buttons**: contextual primary action (see §8 on send/steer/follow-up), attachment affordance (see §9).

## 2. Section model (the conceptual unit of the transcript)

A **section** = one user message + everything the agent does until it produces an assistant message that requests no further tool calls (the "final summary"). In between: thinking blocks, tool calls, tool results, and possibly intermediate assistant messages.

Rendering rules:

- **Completed section (default, collapsed)**: show
  1. the user message,
  2. a compact "activity widget" (e.g. "12 tool calls · 3 min · ▸ expand") indicating hidden intermediate messages,
  3. the final assistant message.
- **Expanding** the activity widget reveals all intermediate messages inline (thinking, tool calls with full parameters, tool results). This should be a pure client-side toggle (Stimulus + `hidden` attr / `details`-like behavior) over HTML that is already in the DOM, so expansion is instant. For very large sections we can lazy-load the expanded HTML via a Turbo Frame instead — decide based on payload size in practice.
- **Streaming section (live)**: everything is **uncollapsed** and streams in token-by-token — thinking deltas, tool-call argument deltas (e.g. watch a `write` tool authoring a long document), tool output. Nothing hidden; the user must always feel progress.
- **Collapse-on-finish**: when the final assistant message arrives (assistant message with zero tool calls → agent goes idle), collapse the intermediate messages. Because the final assistant message sits directly above the prompt box (bottom-anchored), collapsing content *above* it must not shift it: perform the collapse, then compensate `scrollTop` so the final message stays visually fixed (Stimulus measures the height delta and adjusts scroll position in the same frame).

Edge case: compaction/branch-summary entries and back-to-back user messages (see §10) — sections must tolerate a user message following a user message, and non-message entries between sections.

## 3. Streaming transport: SSE, token-level

Replace the current WebSocket render-op protocol with **Server-Sent Events**, which is the Turbo-idiomatic choice (Turbo Streams natively support SSE sources via `<turbo-stream-source>` or `Turbo.connectStreamSource(new EventSource(...))`).

- Endpoint: `GET /workspaces/:id/agents/:label/events` (SSE).
- The server subscribes to the pi session's event stream and forwards, **per token/delta**, as it arrives from the model provider: `text_delta`, `thinking_delta`, `toolcall_delta` (argument streaming), tool start/end, agent start/end, usage/stats updates.
- Wire format — pragmatic hybrid:
  - **Structural changes** (new section shell, new message bubble, new tool-call card, collapse marker, stats region replace) go as **Turbo Stream actions** (`append`, `replace`, `update`) with server-rendered HTML. Fully idiomatic.
  - **Token deltas** are too high-frequency for HTML-wrapping each one. Use a custom lightweight event (`event: delta`, data: `{target, text}`) handled by a small Stimulus controller that appends text nodes (and runs incremental markdown rendering, below). This is the one deliberate departure from pure Turbo Streams; everything else stays idiomatic. Alternatively define a custom Turbo Stream action (`<turbo-stream action="append_text">`) so even deltas ride the same channel — try this first; fall back to raw events only if overhead is a problem.
- **Server-side batching**: coalesce deltas per animation-frame-ish interval (e.g. flush every 16–33 ms) so we send "as fast as the eye can see" without one SSE event per token. This still feels token-by-token, unlike today's sentence-sized chunks.
- **Markdown**: assistant text renders as markdown. Streaming markdown needs incremental rendering client-side (re-render the in-progress message's markdown on each flush, scoped to that one bubble); on `message_end` the server sends an authoritative server-rendered replacement via Turbo Stream so the final DOM is server-produced.
- **Submit path**: the prompt box is a normal `<form>` POST (Turbo) to `/workspaces/:id/agents/:label/messages`; the response is a Turbo Stream that appends the user message bubble + new section shell. All agent output then flows over SSE. Abort/steer are also plain POSTs.
- **Reconnect/late join**: on SSE connect (or EventSource auto-reconnect), the server first sends a full transcript snapshot (server-rendered, completed sections collapsed, in-flight section expanded with content so far), then live deltas. Include a monotonically increasing event id so reconnects can be made gap-free later; v1 can simply re-snapshot on reconnect.

### Why today feels chunky (fix regardless)

Two real causes found in the current code, both must die in the rewrite:

1. The custom **bash tool buffers all output** and emits a single `onData` at process end (`tools.ts` exec wrapper) — tool output appears all at once.
2. WS messages are forwarded per pi event but with no PTY/streaming exec underneath, and rendering is replace-heavy. The new pipeline streams provider deltas straight through with small flush intervals.

## 4. Multi-viewer & lifecycle

- The runtime stays a **server-side singleton per (workspace, agent)** (as today, `runtimes` map). N browsers = N SSE subscribers to one runtime; all receive identical streams. Submissions from any viewer go through the same POST endpoint. No per-viewer state on the server beyond the SSE connection.
- Late-joining viewer mid-stream: gets snapshot (in-flight section expanded + content so far) and then live deltas — including attaching to an in-progress bash PTY (see §6).
- **Persistence/recovery**: pi already persists the session JSONL (`SessionManager.open(agent.path, ...)`). After an atelier app restart, opening the agent tab recreates the runtime from the session file and renders the full transcript from pi's session entries (no parallel atelier transcript store — the pi session file is the source of truth; today's `BaseRuntime.turns` in-memory model is replaced by reading the session). An agent that was mid-turn during a reboot is simply idle again with the transcript intact; the in-flight assistant turn is whatever pi persisted.

## 5. Visual design of messages

- Distinct treatments (color/accent/background) for: **user messages**, **assistant messages**, **system/notice messages**, **thinking blocks**, **tool calls**, **tool results**.
- Tool-call cards show the tool name, full parameters (pretty-printed, expandable if long), status (running/ok/error), duration, and the result. Consider per-tool accent color via `hash(toolName) % palette.length` — cheap to do, easy to remove; ship it behind a CSS-variable so we can judge it visually.
- Streaming message bubbles get a **small inline stop button** (see §8).
- All message HTML is rendered server-side (render functions in `packages/agent/src/server/`); Stimulus only handles expand/collapse, scroll anchoring, delta appending, and xterm widgets.
- Message HTML rendering is **not extensible** via the extension system in v1 (explicit non-goal).

## 6. Bash tool: PTY via tmux + live xterm.js

Replace the buffered docker-exec bash tool with **tmux-backed PTY execution** in the workspace container, reusing the approach (and code) from `packages/terminal`:

- On bash tool invocation, the runtime creates a tmux session in the container with a reserved naming scheme + marker so the terminal tab never lists it (e.g. session name prefix `atelier-agent-…` and/or a tmux environment variable tag; update `listWorkspaceTerminals` to filter these out).
- The command runs inside that tmux session under a PTY (`TERM=xterm-256color`), so progress bars (rsync, package managers, test runners) render properly.
- **Display is decoupled from execution** (the key insight): the tool-call card the server streams to clients includes an "in-progress" marker with the tmux session identifier. The browser then mounts an **inline xterm.js widget** (reusing the terminal package's client code) and attaches to that tmux session through a web app route (same WS attach mechanism the terminal tab uses). The agent runtime independently captures the output for the actual tool result.
- Result capture: the runtime gets the full output for the tool result via the pipe/capture side (e.g. `tee` to a file in the container, or `tmux pipe-pane`), not via xterm scrollback — tool results must be complete even for huge outputs (`cat bigfile`), and must not depend on any browser being attached.
- **When the command finishes**: tear down the live xterm widget and replace it (Turbo Stream `replace`) with a static server-rendered tool-result block (ANSI-stripped or ANSI-to-HTML, truncated with expand). The transient terminal only exists while the command runs.
- **Late attach**: a user opening the tab mid-long-running-command sees the tool card with the live terminal and can attach immediately — this falls out of the tmux design for free.
- Tool-result truncation/limits follow pi's bash tool conventions.

## 7. Assistant-output rewriting: images, videos, dev-server URLs

Goal: prompt the agent to emit container-local resources in a specific syntax (e.g. `atelier://file/...`, `atelier://port/3000` — exact syntax TBD), and have the web app render them as real `<img>`, a polished `<video>` player, or an `<iframe>` tunneled to the dev server.

**Decision: rewrite at render time, not in the session.** The pi session file keeps the agent's original text (the agent's own syntax stays meaningful to the agent across turns and rewinds); the server's HTML renderer translates the syntax into atelier proxy URLs when producing message HTML. This sidesteps the "does the extension API mutate streamed messages, and what gets persisted?" question entirely — no message mutation, no persistence ambiguity, and it works identically for live streaming and snapshot rendering.

- During streaming, only run the rewrite on complete syntax matches (buffer a partial match at the tail of the delta until it completes or disproves); the authoritative `message_end` re-render (§3) cleans up anything missed.
- We still want to use **pi's event subscription system** (`session.subscribe`) as the integration point — which we already use — rather than the extension `message_update`-mutation hooks. (Investigation note: pi extension hooks can modify tool results and context messages, but mutating assistant text mid-stream is murky; a research task below confirms what `message_end`/`context` hooks allow, in case we later prefer canonical rewriting. Not a blocker.)

**Serving container resources** (the hard dependency):

- New authenticated route, e.g. `GET /workspaces/:id/files/*path` → streams the file out of the container. Must support **HTTP Range requests** for video seeking. Docker's archive API is awkward for ranges; preferable: run a tiny static file helper inside the container (or use `docker exec` with `dd`/`tail -c` for range slices, or mount-side access if the host can see the volume). Pick after a spike; Range support is the acceptance criterion.
- Dev-server tunneling: `GET /workspaces/:id/ports/:port/*` reverse-proxy into the container's network for the `<iframe>` case (and websockets for HMR, eventually). Scope v1 to plain HTTP proxying.
- Video player: nice chrome with seeking — use native `<video controls>` over the Range-capable route first; upgrade to a custom-skinned player only if needed.

## 8. Send / steer / follow-up / abort

- **Agent idle**: single **Send** button. Plain message.
- **Agent busy**: typing in the prompt box offers **two actions**: **Steer** (pi's `session.steer` — injected at the next opportunity mid-run) and **Follow-up** (queued; submitted automatically when the agent finishes its final assistant message). Implement follow-up as a server-side queue in the runtime.
- **Abort**:
  - A global abort affordance (Esc keybinding in the prompt box + a button when busy) → `session.abort()`.
  - **Inline stop buttons** on the live streaming artifacts: on the streaming assistant/thinking bubble, and on the live tool-call card (e.g. the tmux terminal widget) — all routed to the same abort endpoint (v1: abort = abort the whole agent run; per-tool-only cancellation is a later refinement if pi supports it).

## 9. Attachments: drag & drop + upload

- **Entire agent tab is a drop target** (Stimulus controller on the tab pane), with `dragover` highlight; crucially, also swallow drops anywhere in the app shell so a missed drop never navigates the browser away (`dragover`/`drop` preventDefault at the document level).
- Dropped files become **attachment chips** in the prompt box (Gmail-style): filename, size, thumbnail for images, remove (×) button. No inline positioning in the prompt text — attachments are message-level.
- **Upload on drop** (not on send): start uploading immediately to a staging endpoint (`POST /workspaces/:id/agents/:label/attachments`), show a progress bar in the chip; Send just references the staged attachment ids. Rationale: large files shouldn't make Send slow; canceling a chip deletes the staged upload. Staged files are garbage-collected if never sent.
- On send, attachments are delivered to the agent: images go into the user message as model-visible images (pi supports image content); other files are copied into the container (e.g. `/repos/.atelier/attachments/…` or a tmp dir) and referenced by path in the user message text.
- User message bubbles render their attachments (image thumbnails / file chips).

## 10. Rewind (session tree) and tail-summary

- Use **pi's session tree** mechanism (same machinery as `/tree`): rewinding = moving the active leaf to an earlier entry; the abandoned tail stays in the JSONL as a branch. Container state is untouched (explicitly: rewind rewinds the *conversation*, not the filesystem).
- **UI**: rewind affordances at **section boundaries** only (v1) — e.g. a hover control on each user message: "Rewind to here". Confirmation dialog offers:
  1. discard tail outright,
  2. replace tail with an **auto-generated summary** (pi's branch summarization),
  3. replace tail with a **custom prompt** (user-written summary text).
- **UX during summarization**: immediately re-render the truncated transcript (Turbo Stream replace of the transcript region), then show the summary-generation exactly like any other "agent busy" state — the summarizing LLM call streams/spins in the same visual slot a pending assistant message would.
- **Section-model integration** (investigated): pi stores compaction and branch summaries as dedicated entry types (`compaction`, `branch_summary`) — *not* as user or assistant messages. So the transcript renderer must handle non-message entries: render a branch summary as a distinct system-styled "summary" block between sections. This also resolves the "two consecutive user messages" worry for summaries; but the section grouping logic must still tolerate consecutive user messages generally (steering can produce them) — rule: a new user message always starts a new section, even if the previous section never got its final assistant message.
- Auto-compaction (currently disabled in the runtime) can later reuse the same rendering: a `compaction` entry renders as a collapsed "context compacted" block.

## 11. Architecture / module layout (rewrite scope)

```
packages/agent/src/
  server/
    runtime.ts          # rewritten: pi session wrapper, section state machine,
                        # follow-up queue, subscriber fanout, stats tracking
    events.ts           # SSE endpoint: snapshot + turbo-stream/delta encoding, batching
    routes.ts           # POST messages / steer / abort / attachments / model / rewind
    render/             # server HTML: sections, bubbles, tool cards, prompt box, stats
    rewrite.ts          # atelier:// syntax → proxy URLs (render-time)
    bash-tmux.ts        # tmux-backed PTY bash tool (reuses terminal package server bits)
    files.ts            # container file serving w/ Range, port proxy (or in core)
  client/
    transcript_controller.ts   # scroll anchoring, collapse compensation
    section_controller.ts      # expand/collapse
    stream_controller.ts       # SSE hookup, delta appends, incremental markdown
    prompt_controller.ts       # textarea grow, Esc=abort, send/steer/follow-up states
    attachments_controller.ts  # drop target, chips, upload progress
    tool_terminal_controller.ts# inline xterm attach (reuses terminal client code)
```

Keep the existing `session-store.ts`, `workspace-title-suggestion.ts`, custom read/write/edit tools (`tools.ts`) largely as-is; delete `sockets.ts`, `render.ts`, `agent-chat-controller.ts`, and the WS protocol.

## 12. Open questions / research tasks (do these first)

1. **Pi event vocabulary**: enumerate exact `session.subscribe` event types/payloads in v0.79 (text/thinking/toolcall arg deltas, usage/cost, message_end shapes) — drives the SSE encoder.
2. **Pi session tree API from SDK**: programmatic equivalents of `/tree` navigation + branch summarization (`session_before_tree` etc. are extension events; confirm SDK-level methods).
3. **Stats source**: where context-%, cost, token counts live on the session object / events.
4. **Custom Turbo Stream action for text deltas**: measure overhead vs raw SSE events at realistic token rates.
5. **Container file serving with Range support**: spike the options (in-container helper vs docker exec slicing).
6. **tmux capture fidelity**: verify `pipe-pane`/`tee` capture gives clean tool-result text for huge outputs and that exit codes are reliably retrievable.
7. **Extension message-mutation API** (low priority, informational): confirm whether pi extensions can canonically rewrite assistant messages and what persists — only matters if we ever move rewriting out of the renderer.

## 13. Suggested phasing

1. **Phase 1 — transport + layout**: SSE pipeline, new transcript/prompt-box layout, token-level streaming of text/thinking, plain tool cards (no PTY yet), send/abort. This alone replaces today's UX.
2. **Phase 2 — sections**: grouping state machine, collapse-on-finish with scroll compensation, expand/uncollapse, distinct message styling.
3. **Phase 3 — prompt box maturity**: stats row, model/provider/thinking selectors, steer + follow-up queue, Esc/stop buttons.
4. **Phase 4 — PTY bash**: tmux execution, inline xterm attach, static result replacement, late-attach.
5. **Phase 5 — attachments**: drop target, staged uploads, chips, container delivery.
6. **Phase 6 — media rewriting**: file-serving route with Range, port proxy, `atelier://` rewrite, image/video/iframe rendering.
7. **Phase 7 — rewind**: section-boundary rewind UI, tree navigation, summary/custom-prompt options, summary-entry rendering.

Each phase keeps multi-viewer and restart-recovery working (they're structural, from Phase 1's snapshot-on-connect design).

---

## Implementation status (2026-06-10)

Implemented in this repo (all phases except WebSocket-grade HMR proxying):

- **Transport**: SSE per agent (`GET /workspaces/:id/agents/:label/events`) carrying turbo-streams; token deltas ride a custom `append_text` turbo-stream action, server-batched at 25 ms. Form posts for messages/steer/follow-up/abort/model/thinking/rewind/attachments.
- **Layout & design**: bottom-pinned prompt box (stats bar in muted gray, provider/model/thinking selects, context meter, ↑/↓ tokens, cost), transcript hugs the prompt box, user messages = white bubbles matching the prompt box, assistant finals = plain typeset text, thinking = mild gray, flat quiet tool line-items (no tinted edge), no per-message role/model labels, integrated `■ <elapsed>` stop button only on the streaming section.
- **Sections**: grouped via `buildSections()` (`transcript.ts`); collapsed by default with `N tool calls · thinking · time · tok · $cost` summary; during streaming only the **last** activity item is visible (pure CSS `:last-child` rule) and earlier ones auto-collapse as new items arrive; final message replaces in place at run end (canonical re-render).
- **Runtimes**: `RealAgentRuntime` (pi SDK; session JSONL is the source of truth, restart-safe) and `FakeAgentRuntime` (`ATELIER_AGENT_FAKE=1`, deterministic, docker-free; used for UI dev + Playwright).
- **Bash**: tmux-marked sessions (`atelier-agent-*`) under PTY via `script` capture; live read-only xterm attach over `/workspaces/:id/agent-term/:session/ws`; terminal tab listing filters agent sessions; result captured independently of viewers.
- **Media rewriting**: render-time only (session keeps original text); `atelier://file/...` → inline `<img>`/`<video>`/link via Range-capable `GET /workspaces/:id/agent-files`; `atelier://port/...` → iframe via `GET /workspaces/:id/agent-port/:port/*` (GET-only proxy v1).
- **Attachments**: whole-pane drop target + global drop guard, upload-on-drop with progress chips, staged server-side; images go to the model as base64, other files are copied into the container.
- **Rewind**: hover affordance at section boundaries → dialog with discard / AI summary / custom-note options (pi `navigateTree`); prompt box prefilled with the rewound user message.
- **Multi-viewer + recovery**: verified — N SSE subscribers share one runtime; snapshot-on-connect restores mid-stream and after server restart.

Verified with Playwright against the fake runtime (streaming, collapse/expand, steer, follow-up, abort, rewind, attachments, media, reload, second viewer). Real-runtime specifics (tmux bash, model selection) follow the same code paths but need a docker + API-key environment for end-to-end testing.
