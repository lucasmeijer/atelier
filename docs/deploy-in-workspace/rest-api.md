# Atelier REST API

Atelier exposes a small JSON API under `/api`.

## Create a workspace

```http
POST /api/workspaces
Content-Type: application/json
```

Creates a workspace asynchronously and returns immediately while provisioning continues.

### Empty workspace

```json
{}
```

or:

```json
{
  "source": { "type": "empty" }
}
```

### Workspace from a saved project

```json
{
  "source": { "type": "project", "project": "sample-project" },
  "prompt": "Fix the tests"
}
```

`source.project` may be either the project id or a unique project name.

Optional agent fields:

```json
{
  "source": { "type": "project", "project": "sample-project" },
  "prompt": "Fix the tests",
  "agent": {
    "model": "openai::gpt-4.1",
    "thinkingLevel": "medium"
  }
}
```

`model` and `thinkingLevel` are optional.

### Response

```http
202 Accepted
Location: http://atelier.example/workspaces/abc12345
Content-Type: application/json
```

```json
{
  "workspace": {
    "id": "abc12345",
    "url": "http://atelier.example/workspaces/abc12345",
    "phase": "starting"
  }
}
```

Use `workspace.url` or the `Location` header to open the workspace.

### Errors

Errors are returned as JSON:

```json
{
  "error": {
    "code": "invalid_arguments",
    "message": "source.type must be empty or project"
  }
}
```
