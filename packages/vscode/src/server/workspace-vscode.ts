import { execWorkspaceShell, workspaceRoot } from "@atelier/workspace";

export interface WorkspaceVSCodeTab {
  title: string;
}

const tabs = new Map<string, WorkspaceVSCodeTab[]>();

function defaultTabs(): WorkspaceVSCodeTab[] {
  return [{ title: "VS Code" }];
}

export function listWorkspaceVSCodeTabs(workspaceId: string): WorkspaceVSCodeTab[] {
  const existing = tabs.get(workspaceId);
  if (existing) return existing;
  const seeded = defaultTabs();
  tabs.set(workspaceId, seeded);
  return seeded;
}

export function createWorkspaceVSCodeTab(workspaceId: string): WorkspaceVSCodeTab {
  const existing = listWorkspaceVSCodeTabs(workspaceId);
  let index = existing.length + 1;
  let title = `VS Code ${index}`;
  const used = new Set(existing.map((tab) => tab.title));
  while (used.has(title)) {
    index += 1;
    title = `VS Code ${index}`;
  }
  const tab = { title };
  existing.push(tab);
  tabs.set(workspaceId, existing);
  return tab;
}

export function deleteWorkspaceVSCodeTab(workspaceId: string, title: string): void {
  const existing = tabs.get(workspaceId);
  if (existing) tabs.set(workspaceId, existing.filter((tab) => tab.title !== title));
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
