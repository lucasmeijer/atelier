import type { JsonValue } from "@atelier/core";
import { createWorkspaceMetadataState, execWorkspaceShell, workspaceRoot } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const workspaceVSCodeViewSchema = Type.Object({
  title: Type.String({ pattern: "\\S" }),
});
const workspaceVSCodeViewsSchema = Type.Array(workspaceVSCodeViewSchema);

export type WorkspaceVSCodeView = Static<typeof workspaceVSCodeViewSchema>;

function defaultViews(): WorkspaceVSCodeView[] {
  return [];
}

function parseVSCodeViews(value: JsonValue): WorkspaceVSCodeView[] {
  if (!Value.Check(workspaceVSCodeViewsSchema, value)) throw new Error("invalid persisted VS Code Work views");
  return value.map(({ title }) => ({ title }));
}

const vscodeViews = createWorkspaceMetadataState("vscode-work-views.json", parseVSCodeViews, defaultViews);

export function listWorkspaceVSCodeViews(workspaceId: string): WorkspaceVSCodeView[] {
  return vscodeViews.read(workspaceId);
}

export function createWorkspaceVSCodeView(workspaceId: string): WorkspaceVSCodeView {
  const existing = listWorkspaceVSCodeViews(workspaceId);
  const used = new Set(existing.map((view) => view.title));
  let index = 1;
  let title = "VS Code";
  while (used.has(title)) {
    index += 1;
    title = `VS Code ${index}`;
  }
  const view = { title };
  existing.push(view);
  vscodeViews.write(workspaceId, existing);
  return view;
}

export function deleteWorkspaceVSCodeView(workspaceId: string, title: string): void {
  vscodeViews.write(workspaceId, vscodeViews.read(workspaceId).filter((view) => view.title !== title));
}

export function deleteWorkspaceVSCodeState(workspaceId: string): void {
  vscodeViews.delete(workspaceId);
}

export async function ensureWorkspaceVSCodeServer(workspaceId: string): Promise<void> {
  const result = await execWorkspaceShell(workspaceId, `
    set -eu
    server_pattern='[c]ode serve-web|[c]ode-server'
    ready_url='http://127.0.0.1:8000/'

    is_ready() {
      curl -fsS --max-time 2 "$ready_url" >/dev/null 2>&1
    }

    server_is_running() {
      pgrep -u atelier -f "$server_pattern" >/dev/null 2>&1
    }

    start_server() {
      mkdir -p /.atelier/vscode
      if command -v atelier-start-vscode >/dev/null 2>&1; then
        nohup atelier-start-vscode > /.atelier/vscode/server.log 2>&1 &
      else
        code_bin=code
        nohup "$code_bin" serve-web --accept-server-license-terms --host 0.0.0.0 --port 8000 --without-connection-token --default-folder ${workspaceRoot} > /.atelier/vscode/server.log 2>&1 &
      fi
    }

    if is_ready; then
      exit 0
    fi

    if ! server_is_running; then
      start_server
    fi

    for _ in $(seq 1 120); do
      if is_ready; then
        exit 0
      fi
      if ! server_is_running; then
        start_server
      fi
      sleep 0.5
    done

    echo "VS Code server did not become ready at $ready_url" >&2
    tail -n 80 /.atelier/vscode/server.log /.atelier/vscode-server.log 2>/dev/null || true
    exit 1
  `, { user: "atelier" });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `could not start VS Code server for ${workspaceId}`);
}
