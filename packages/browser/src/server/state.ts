import { domId } from "@atelier/shared";

export interface WorkspaceBrowserTab {
  key: string;
  label: string;
  targetUrl: string;
}

const browserTabsByWorkspace = new Map<string, WorkspaceBrowserTab[]>();

export function browserFrameId(workspaceId: string, appKey: string): string {
  return domId("browser_frame", workspaceId, appKey);
}

export function listWorkspaceBrowserTabs(workspaceId: string): WorkspaceBrowserTab[] {
  const existing = browserTabsByWorkspace.get(workspaceId);
  if (existing) return existing;
  const tabs: WorkspaceBrowserTab[] = [];
  browserTabsByWorkspace.set(workspaceId, tabs);
  return tabs;
}

export function getWorkspaceBrowserTab(workspaceId: string, appKey: string): WorkspaceBrowserTab | undefined {
  return listWorkspaceBrowserTabs(workspaceId).find((tab) => tab.key === appKey);
}

export function createWorkspaceBrowserTab(workspaceId: string): WorkspaceBrowserTab {
  const existing = listWorkspaceBrowserTabs(workspaceId);
  const used = new Set(existing.map((tab) => tab.key));
  let index = existing.length + 1;
  let key = `browser-${index}`;
  while (used.has(key)) {
    index += 1;
    key = `browser-${index}`;
  }
  const tab = { key, label: `Browser ${index}`, targetUrl: "" };
  existing.push(tab);
  return tab;
}

export function deleteWorkspaceBrowserTab(workspaceId: string, appKey: string): void {
  browserTabsByWorkspace.set(workspaceId, listWorkspaceBrowserTabs(workspaceId).filter((tab) => tab.key !== appKey));
}

export function setWorkspaceBrowserTarget(workspaceId: string, appKey: string, input: string): WorkspaceBrowserTab | undefined {
  const tab = getWorkspaceBrowserTab(workspaceId, appKey);
  if (!tab) return undefined;
  tab.targetUrl = normalizeBrowserUrl(input);
  return tab;
}

export function deleteWorkspaceBrowserState(workspaceId: string): void {
  browserTabsByWorkspace.delete(workspaceId);
}

export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (!parsed.hostname) return "";
  return parsed.toString();
}
