# Codex-compatible, observable subagents

Atelier’s shared system prompt instructs root agents and subagents to delegate only
when the user explicitly requests subagents or delegation to other agents. This
includes spawning and assigning follow-up tasks; possible speed or parallelism
is not authorization. This is a model instruction, not a runtime permission gate,
and does not change the pinned tool descriptions below.

## Pinned model-facing contract

Reference: OpenAI Codex [`574a36ff99f0807a24f5b043f593122bf151908d`](https://github.com/openai/codex/tree/574a36ff99f0807a24f5b043f593122bf151908d), cloned at `/persistent/atelier-codex-reference` in the implementation workspace. Source descriptions and schemas are attributed in NOTICE; the Apache-2.0 license is in `docs/licenses/codex-LICENSE`.

Atelier uses the **MultiAgentV2** surface with optional role/model overrides disabled and nickname metadata hidden. This is a specific supported Codex configuration, not a mixture of the v1 and v2 tools:

| Tool | Input | Result |
| --- | --- | --- |
| `spawn_agent` | `task_name`, `message`, optional `fork_turns` | `{ task_name: "/root/child" }` |
| `send_message` | `target`, `message` | Empty text acknowledgement |
| `followup_task` | `target`, `message` | Empty text acknowledgement |
| `list_agents` | Optional `path_prefix` | `{ agents: [{ agent_name, agent_status }] }`, including `/root` |
| `wait_agent` | Optional `timeout_ms` | `{ message, timed_out }`, **without duplicating message contents** |
| `interrupt_agent` | `target` | `{ previous_status }` |

Descriptions are copied from the pinned `multi_agents_spec.rs`. Input property descriptions and provider-facing output schemas use the same contract. Encryption annotations are deliberately omitted: all agent-to-agent payloads remain plaintext. The earlier mixed-in v1 `close_agent` and `resume_agent` are no longer exposed to the model; internal close remains available for conversation/workspace disposal.

Canonical names are `/root`, `/root/review`, `/root/review/check`, etc. Relative references resolve beneath the caller. The same leaf name can exist under different parents. IDs remain internal correlation data rather than part of the message text. A non-root agent can receive follow-up tasks or interruption from another agent in the same tree. Other root trees/workspaces remain isolated.

`fork_turns` defaults to `all`; `none` starts from the explicit task, and a positive integer string selects recent user turns. The fork preserves complete exchanges and removes unresolved tool calls (notably the spawning call, whose result has not arrived yet) so the child never submits orphaned tool calls to a provider. Existing sessions are not re-forked on reload. Children inherit model/thinking settings, tools, skills and workspace instructions. They share the workspace filesystem—not separate worktrees.

`followup_task` starts an idle child directly from its attributed task message; while running, it steers at message boundaries rather than waiting behind the entire run. There is no fabricated “Carry out the task above” user prompt. `send_message` and automatic completions do not start idle recipients. Wait defaults to 30 seconds, clamps short requests to 10 seconds, and permits up to one hour. It wakes for incoming traffic or steered user input; abort cancels it.

## Native model delivery—not user-role text

The plaintext payload uses Codex's exact envelope:

```text
Message Type: MESSAGE
Task name: /root
Sender: /root/review
Payload:
The actual message text.
```

Tasks use `NEW_TASK`; final results use `FINAL_ANSWER`. Failure completions include Codex's failure/action wording. The ordinary completion body is the child's final text, without an additional `[completed]` prefix.

Pi persists these as attributed `custom_message` entries. For inference, `SubagentModelInput` bridges Pi's standard message pipeline to a **native Codex Responses input item**:

```json
{
  "type": "agent_message",
  "author": "/root/review",
  "recipient": "/root",
  "content": [{ "type": "input_text", "text": "Message Type: MESSAGE\n..." }]
}
```

On Codex Responses, this is not a `user` message with a decorative prefix. Per-conversion opaque placeholders keep the typed identity through Pi's conversion, and the provider payload hook replaces them before transmission. No placeholder or UUID enters the textual envelope. Ordinary user text, even if it looks like the envelope, does not acquire agent-message semantics. The payload hook also supplies the pinned tool output schemas.

**Provider mapping:** `openai-codex-responses` receives native agent-message items. Other transports, including Anthropic, receive ordinary user messages containing the same attributed plaintext envelope. This mapping happens before Pi serializes the provider request; no native placeholder reaches those APIs. Delivery records retain which format was used. Ordinary conversations without subagent traffic are unchanged. This implementation does not claim to reproduce Codex's entire Rust runtime, provider-independent compaction machinery, role configuration, or residency scheduler. Atelier bounds execution to six concurrent children per tree and depth three.

## Presentation is separate from model delivery

Open **Subagents** from the Work-view launcher. It follows the selected root Agent tab. There is no root selector, repeated header, or separate communication dashboard. Children form a divider-free action-item list with normal body typography, canonical paths and lifecycle state; each opens its native Atelier transcript. Nested children appear beneath their parent. Multiple transcripts can stay open, with browser-local expansion state retained per root.

Incoming messages appear in the recipient transcript from the durable routing ledger, immediately after receipt is persisted—not only when Pi incorporates them into model context. They are foldable action-items with a green incoming-message dot and labels such as “Incoming message from: /root/review type: update”. Message, completion and task traffic display as update, completed and task. Expanding the row reveals the body and delivery state, without transport IDs. A subtle **Pending context** label distinguishes queued traffic; failure remains visible. Updating delivery changes the same identified entry, rather than inserting a second copy. Arrival order is a presentation timeline; it is not a claim about provider message ordering or that a model read/acted on a message.

Outgoing messages remain visible as their actual tool calls. Automatic outgoing completion is correlated with the child's final response. The “Open subagent” action inside an expanded incoming entry opens the Subagents Work view (including if it was closed), expands the corresponding child and its containing Working section when necessary, and reveals the related tool call or final response. UUIDs are carried internally for reliable navigation, not shown as prose.

All HTML is server-rendered. The selected root has a Cable tree subscription: an authoritative initial snapshot followed by inserted/removed branches and changed status summaries. Expanded children use the existing Agent live-presentation streams, including streamed text and tool activity. Collapsed descendants, hidden views and background browser tabs release subscriptions; opening and reconnecting obtain fresh snapshots. There is no polling timer and historical inspection or text selection does not pause other updates. Status updates never replace child transcript DOM. Turbo Frames remain available for explicit historical details and source-navigation requests.

## Persistence and lifecycle

```text
workspaces/<workspace-id>/subagents/state.json       # tree, plaintext messages, delivery, wait read positions
workspaces/<workspace-id>/subagents/<agent-id>.jsonl # native Pi session
```

Ledger writes are serialized and atomically renamed. Task/message IDs connect the sender's tool call, routing event, recipient context and visualization. They remain accessible in the JSON representation for debugging. No application-layer encryption is used; ordinary provider transport security remains unchanged. Do not send secrets in inter-agent messages.

Closing a root conversation stops its descendants. Interrupting a child stops that child's current turn, clears pending input, and retains its transcript and availability. Unacknowledged discarded messages become failed rather than lingering as supposedly deliverable. Workspace removal shuts down coordination and disposes all sessions.

After a server restart, previously running/starting children become interrupted. Unacknowledged traffic becomes failed with an explicit explanation; tasks are not silently replayed. Inspect the retained transcript before resending.

## Automation and verification

Follow [automation.md](automation.md) and discover the running instance's `/openapi.json`.

- `subagents.open` opens `{ "type": "subagents" }`.
- `GET /workspaces/:id/subagents?agent=:conversationId` with `Accept: application/json` inspects the tree and ledger.
- A browser workspace URL can select the root and view with `?agent=:conversationId&workView=subagents:workspace`.
- `subagent=:childId&message=:messageId` additionally reveals a correlated message after the view is open.

Non-UI tests cover native request serialization, envelopes, tool schemas, output schemas, plaintext-only behavior, provider user-message mapping, paths, history forks, wait/steer/abort, lifecycle, routing isolation and persistence. No UI tests are added. The running instance has been exercised with real model calls using native `agent_message`, both fresh and inherited child contexts, progress messages, final results, follow-up tasks and `list_agents`.

Incoming message disclosures start expanded; user folding survives delivery updates.
They stay outside Working blocks because receipt is independent of a model turn.
The muted **Find source** action reveals the sender's tool call (including spawn and
follow-up task calls); automatic completions reveal its final response instead.
Dedicated spawn/message/follow-up details show the plaintext payload and **Find message
recipient**, which reveals the matching receipt in the destination root or child.

Communication disclosures use the standard tool-card shell with labelled table
rows. Outgoing cards contain Body and Recipient; incoming cards contain Type,
Source and Body, plus Context when pending or failed. Trace navigation expands
and scrolls to its target without adding an outline.

Receipt is persisted before session delivery, so its incoming card appears
immediately outside Working groups. The queued/delivered transition acknowledges
Pi's custom-message `message_end` event (added to session context), not a provider
request or proof that the model read it. Pending context disappears on that
acknowledgement. A separate delivery batch now records the first inclusion in a
prepared provider request, as described below. An idle recipient can have the message in context without a
new inference turn. Outgoing calls stay inside the sender's Working group;
automatic final responses and incoming receipts stay outside it.


### Model-input delivery batches

The pending-message queue means messages routed to this recipient which have not
been recorded in a prepared model request. At the Codex payload hook, new messages
are recorded together in a `subagent_model_delivery` session metadata entry. It
contains the plaintext envelopes and a point-in-time remaining count. Metadata is
not itself sent to the model. Normal history replay and request retries do not
create duplicate queue-drain entries. Forked ancestor traffic is not a new receipt
for the child. These records follow session branches and survive restart.

The transcript says “Delivered N messages from queue. Queue is now empty.” (or
reports the remaining count). Each card links to the original receipt and shows
the delivered plaintext envelope. The first request of a run is outside Working;
subsequent requests during the activity go inside Working. This is the provider
payload preparation boundary, **not** HTTP acceptance, successful inference, or a
read receipt; a subsequent request failure does not undo that recorded event.

Native `agent_message` is the Codex Responses input contract. Other transports
use the user-message mapping above. This deliberately provides attribution as
plaintext, not the native transport's typed agent-message identity.

An idle spawn/follow-up task starts inference immediately. Its incoming card is
updated in place with **Delivered as** once the provider payload is prepared;
there is no separate queue-drain item. Ordinary messages waiting for the next
user turn and traffic steered during an active run remain separate receipt and
delivery events. The distinction is recorded when dispatching, not inferred from
elapsed time. Older records without that distinction remain separate.
The source action is one link: **Sent from /root/path here**.


Incoming cards include a **Handling** row. Dispatch records retain the reason at
arrival: an idle task can start inference immediately; an idle ordinary message
waits for a later turn; an active recipient queues traffic for a model-request
boundary; and an active `wait_agent` is identified separately. Waiting in a tool
is not equivalent to idle inference. Delivery does not rewrite that historical
reason. Old records without a reason say it was not recorded rather than guessing
from the recipient's current state. Receipt remains visible before dispatch is
decided, and immediate delivery is only described as completed once its prepared
model-request envelope is recorded.
