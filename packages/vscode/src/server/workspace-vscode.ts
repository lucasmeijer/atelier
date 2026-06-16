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
  const existing = listWorkspaceVSCodeTabs(workspaceId).filter((tab) => tab.title !== title);
  tabs.set(workspaceId, existing);
}

export async function ensureWorkspaceVSCodeServer(workspaceId: string): Promise<void> {
  const result = await execWorkspaceShell(workspaceId, `
    set -eu
    if pgrep -u atelier -f 'code serve-web' >/dev/null 2>&1; then
      exit 0
    fi
    mkdir -p /.atelier/vscode
    if command -v atelier-start-vscode >/dev/null 2>&1; then
      nohup atelier-start-vscode > /.atelier/vscode/server.log 2>&1 &
    else
      nohup code serve-web --accept-server-license-terms --host 0.0.0.0 --port 8000 --without-connection-token --default-folder ${workspaceRoot} > /.atelier/vscode/server.log 2>&1 &
    fi
  `, { user: "atelier" });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `could not start VS Code server for ${workspaceId}`);
}
