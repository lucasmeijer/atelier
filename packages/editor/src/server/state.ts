import { posix } from "node:path";

export interface WorkspaceFileEditorTab {
  key: string;
  path: string;
  line?: number;
  column?: number;
}

const tabsByWorkspace = new Map<string, WorkspaceFileEditorTab[]>();

function tabKey(path: string): string {
  return `file-editor:${Buffer.from(path).toString("base64url")}`;
}

export function listWorkspaceFileEditorTabs(workspaceId: string): WorkspaceFileEditorTab[] {
  return tabsByWorkspace.get(workspaceId) ?? [];
}

export function openWorkspaceFileEditorTab(workspaceId: string, path: string, position: { line?: number; column?: number } = {}): { tab: WorkspaceFileEditorTab; created: boolean } {
  let tabs = tabsByWorkspace.get(workspaceId);
  if (!tabs) tabsByWorkspace.set(workspaceId, tabs = []);
  const existing = tabs.find((tab) => tab.path === path);
  if (existing) {
    existing.line = position.line;
    existing.column = position.column;
    return { tab: existing, created: false };
  }
  const tab = { key: tabKey(path), path, ...position };
  tabs.push(tab);
  return { tab, created: true };
}

export function closeWorkspaceFileEditorTab(workspaceId: string, key: string): void {
  const tabs = tabsByWorkspace.get(workspaceId);
  if (tabs) tabsByWorkspace.set(workspaceId, tabs.filter((tab) => tab.key !== key));
}

export function deleteWorkspaceFileEditorState(workspaceId: string): void {
  tabsByWorkspace.delete(workspaceId);
}

export function fileEditorTabLabels(tabs: WorkspaceFileEditorTab[]): Map<string, string> {
  const basenameCounts = new Map<string, number>();
  for (const tab of tabs) {
    const basename = posix.basename(tab.path);
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }
  return new Map(tabs.map((tab) => {
    const basename = posix.basename(tab.path);
    const label = (basenameCounts.get(basename) ?? 0) > 1 ? `${posix.basename(posix.dirname(tab.path))}/${basename}` : basename;
    return [tab.key, label];
  }));
}
