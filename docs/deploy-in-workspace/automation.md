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

## Create and wait for a workspace

Creation is asynchronous and returns `202 Accepted` immediately:

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

A ready response advertises its `tabs`, normalized `layout`, and available `commands` with their `inputSchema`.

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
