# Automating Atelier

Atelier's web UI operations also provide compact JSON representations for agents and scripts. They are the same operations used by the Turbo UI, not a separate REST implementation.

## Discovery

The authoritative contract for the running instance is:

```http
GET /openapi.json
```

Inspect it without loading the whole document into context:

```sh
curl -s http://localhost:3000/openapi.json | jq -r '.paths | keys[]'
curl -s http://localhost:3000/openapi.json | jq '.paths["/workspaces/{id}/commands/{commandId}"]'
```

Send these headers for JSON operations:

```http
Accept: application/json
Content-Type: application/json
```

Errors use `{ "error": { "code": "...", "message": "..." } }`.

## Present a workspace

Workspace, Agent conversation, and Work-view destinations are browser-navigable surfaces:

```text
/workspaces/:workspaceId
/workspaces/:workspaceId?agent=:conversationId
/workspaces/:workspaceId?workView=:key
```

The `agent` and `workView` parameters may be combined to choose both sides of the desktop workspace. Use `GET /workspaces/:workspaceId` with `Accept: application/json` to discover the available Agent conversation IDs and the `key` of each Work view.

## Present project settings

Project settings has a browser-navigable surface that agents can pass directly to their presentation tool:

```text
/projects/:projectId/settings
/projects/:projectId/settings?section=environment
```

Supported sections are `repository`, `secrets`, `ssh-keys`, `environment`, and `danger`. Direct navigation renders the complete Atelier shell, opens Project settings, expands configurable sections when selected, and scrolls the selected section into view.

Use `GET /projects` with `Accept: application/json` to discover the project ID before constructing the presentation URL.

Other browser-navigable surfaces are:

```text
/workspaces/new                         # New projectless workspace
/projects/:projectId/workspaces/new     # New workspace for a project
/projects/new                           # Add a project
/usage                                  # Provider-reported limits
/settings                               # Atelier settings
/settings?section=models                # A specific settings section
/settings/development                   # Development settings
/design-system-catalogue.html           # Live component catalogue (HTML)
```

The settings section is a registered settings contribution ID, such as `theme`, `git-identity`, `github`, `models`, `transcription`, or `update`.

## Create and wait for a workspace

Creation is asynchronous and returns `202 Accepted` immediately. The response’s
`workspace.url` and `Location` header are origin-relative paths, like workspace
detail URLs. Resolve them against the public request URL to preserve HTTPS
when Atelier runs behind a TLS-terminating proxy:

```sh
created=$(curl -sS -X POST http://localhost:3000/workspaces \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"source":{"type":"empty"},"title":"Evaluation"}')
id=$(jq -r '.workspace.id' <<<"$created")
```

`source` may be `{ "type": "empty" }` or `{ "type": "project", "project": "name-or-id" }`. Optional `agent` fields are `initialPrompt`, `model`, `thinkingLevel`, `serviceTier`, and `attachmentDraft`.

Poll the same UI URL with JSON content negotiation:

```sh
while :; do
  workspace=$(curl -sS -H 'Accept: application/json' "http://localhost:3000/workspaces/$id")
  phase=$(jq -r '.workspace.phase' <<<"$workspace")
  [ "$phase" = ready ] && break
  [ "$phase" = failed ] && { jq . <<<"$workspace"; exit 1; }
  sleep .2
done
```

Existing workspaces are discovered before the server starts listening. Each active
workspace then runs its startup checklist in the background with phase `starting`.
Gateway readiness is a checklist step with a 15-second timeout. Failure pauses that
workspace's startup and presents **Continue without gateway support**. The existing
`POST /workspaces/:id/provisioning/continue` operation acknowledges this failure.
Only then does the workspace become `ready`, retaining its gateway warning. Until
startup completes, the workspace shows its checklist instead of its Agents or Work
views. Atelier and other workspaces remain available throughout.

The list and detail responses include optional `issues` entries with `kind` and
`message`. Image inspection runs independently at Atelier startup. Gateway checks
run again when a workspace is unparked or Atelier restarts; continuing does not permanently disable checks.

A ready response advertises its `agentConversations`, typed `workViews`, and available `commands` with their `inputSchema`.

## Stage Agent conversations and Work views

Execute commands using their advertised schema:

```sh
curl -sS -X POST "http://localhost:3000/workspaces/$id/commands/terminal.create" \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"title":"Tests","cwd":"/work","command":"bun test"}'

curl -sS -X POST "http://localhost:3000/workspaces/$id/commands/browser.create" \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:3000/"}'

curl -sS -X POST "http://localhost:3000/workspaces/$id/commands/agent.create" \
  -H 'Accept: application/json' -H 'Content-Type: application/json' -d '{}'
```

Navigate an existing Browser Work view with `POST /workspaces/:id/browser/:browserId/navigate` and `{ "url": "..." }`.

## Arrange Work views

- `POST /workspaces/:id/work-views/reorder` with `key` and `index`
- `POST /workspaces/:id/work-views/close` with a typed `reference`
- `POST /workspaces/:id/work-views/:key/attention/request` to reveal a Work view and request Attention

Open Work-view identity, order, and Attention are server-persistent. Active destinations, pane visibility, and Work-pane width are browser-local.

The Agent `/park` message responds with a `307` redirect to the workspace park operation.
Follow redirects while preserving the POST method and Accept header (for example, `curl -L`).
Confirmation is returned only to that requester; JSON clients receive `409` when confirmation is needed.

Rename with `POST /workspaces/:id/sidebar-title` and `{ "title": "..." }`. Park, unpark, and delete use the corresponding existing workspace UI routes with `Accept: application/json`.

## Control an agent

- `POST /workspaces/:id/agents/:label/model` with `{ "model": "provider::model" }`
- `POST /workspaces/:id/agents/:label/thinking` with `{ "level": "medium" }`
- `POST /workspaces/:id/agents/:label/service-tier` with `{ "serviceTier": "default" | "priority" }`
- `POST /workspaces/:id/agents/:label/messages` with `{ "text": "...", "mode": "send" }`
- `POST /workspaces/:id/agents/:label/abort`

Message submission returns `202 Accepted`; it does not wait for inference to finish.

## Present the result

After staging the desired Work view, use the agent's `present` tool with:

```text
http://localhost:3000/workspaces/<id>
```

## Inspect provider usage

`GET /usage` with `Accept: application/json` returns all connected providers with
implemented subscription-usage support (OpenAI Codex and Anthropic). Refresh an
individual provider with `GET /usage/providers/openai-codex` or
`GET /usage/providers/anthropic` and the same header. Anthropic requires subscription
OAuth sign-in, not an API key. Its five-hour, weekly, and available model/feature
windows use the same pacing reference. Buckets with no reset timestamp retain
their reported usage, with null reset and timing values and timing state `unknown`.
Null buckets are omitted; monetary extra usage is not a paced allowance. Anthropic
does not report a plan name or account-wide allowed/limit-reached flags, so these
are null.
The HTML representations drive the Usage dialog next to workspace Settings.

Each result includes provider-reported windows, their durations and resets,
and pacing relative to elapsed time. Provider failures populate `error`.
The Usage feature does not record or persist installation-wide token totals.

The Usage dialog groups provider-reported 0% windows under **Unused limits**
(collapsed when there are used limits, expanded when all limits are unused)
and renders reset countdowns such as `3d 12h`. The workspace Usage button traces
Time and Usage for the selected Agent’s provider, retaining the
most recent provider when no workspace is visible. It refreshes every minute
while visible, on focus, and after a dialog refresh. Unsupported, disconnected,
or unavailable providers have no comparison ring. Both arcs start at twelve
o’clock and run clockwise on the same circle. Their shared portion is neutral;
Time beyond Usage is green, and Usage beyond Time is red. A dim full-circle
track preserves the button outline beneath the arcs.
Among active windows with nonzero usage, the button selects the greatest
Usage-minus-Time difference; ties prefer higher Usage. When all active windows are
unused, the main allowance takes precedence over feature-specific allowances.
Expired/not-started windows and windows with unknown reset timing are excluded.
`GET /usage/button?provider=openai-codex` returns the server-rendered button frame
(or a Turbo Stream with `Accept: text/vnd.turbo-stream.html`).

When no current or browser-remembered provider is available (for example opening
`/usage` in a fresh tab), the button uses the saved most-recent model provider.
Each window also includes `timing`: the inferred start (`reset − duration`),
elapsed-time percentage, and usage-minus-time difference in percentage points.
`paceDifferenceSeconds` converts that difference to distance along the allowance
schedule (`paceDifferencePoints / 100 × durationSeconds`). The dialog and button
label show compact durations such as `30m ahead of pace` or `1d 4h behind pace`.
Positive means consumption is ahead; negative means behind. This is not time
until exhaustion. Both difference fields are null outside an active window.
The dialog shows Time and Usage percentages above one comparison bar per allowance.
Both grow from the left: overlap is neutral, Time beyond Usage is green, and Usage
beyond Time is red. Outside an active window the bar stays neutral. This is a linear pacing
reference, not a billing forecast; pacing is omitted before a window starts or
once its reset is due.

Usage is contributed by the Agent module, including these OpenAPI paths. Its
header action and directly navigable dialog use the generic
[module-owned workspace-pane action interface](workspace-pane-actions.md).
