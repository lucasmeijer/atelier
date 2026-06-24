const defaultTargetUrl = "http://localhost:3000/";
const defaultBrowserAppKey = "browser";

export interface WorkspaceBrowserTab {
  key: string;
  label: string;
  targetUrl: string;
}

const browserTabsByWorkspace = new Map<string, WorkspaceBrowserTab[]>();

function defaultTabs(): WorkspaceBrowserTab[] {
  return [{ key: defaultBrowserAppKey, label: "Browser", targetUrl: defaultTargetUrl }];
}

export function browserFrameId(workspaceId: string, appKey = defaultBrowserAppKey): string {
  return ["browser_frame", workspaceId, appKey].join("_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function listWorkspaceBrowserTabs(workspaceId: string): WorkspaceBrowserTab[] {
  const existing = browserTabsByWorkspace.get(workspaceId);
  if (existing) return existing;
  const seeded = defaultTabs();
  browserTabsByWorkspace.set(workspaceId, seeded);
  return seeded;
}

export function getWorkspaceBrowserTab(workspaceId: string, appKey = defaultBrowserAppKey): WorkspaceBrowserTab | undefined {
  return listWorkspaceBrowserTabs(workspaceId).find((tab) => tab.key === appKey);
}

export function getWorkspaceBrowserTargetUrl(workspaceId: string, appKey = defaultBrowserAppKey): string {
  return getWorkspaceBrowserTab(workspaceId, appKey)?.targetUrl ?? defaultTargetUrl;
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
  const tab = { key, label: `Browser ${index}`, targetUrl: defaultTargetUrl };
  existing.push(tab);
  return tab;
}

export function deleteWorkspaceBrowserTab(workspaceId: string, appKey: string): void {
  if (appKey === defaultBrowserAppKey) return;
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
  if (!trimmed) return defaultTargetUrl;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    parsed = new URL(defaultTargetUrl);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") parsed = new URL(defaultTargetUrl);
  if (!parsed.hostname) parsed = new URL(defaultTargetUrl);
  return parsed.toString();
}
