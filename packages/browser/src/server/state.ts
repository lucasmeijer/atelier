const defaultTargetUrl = "http://localhost:3000";
export const defaultBrowserAppKey = "browser";

export interface WorkspaceBrowserTab {
  appKey: string;
  label: string;
}

export interface WorkspaceBrowserState {
  targetUrl: string;
}

const browserTabsByWorkspace = new Map<string, WorkspaceBrowserTab[]>();
const browserStateByWorkspace = new Map<string, Map<string, WorkspaceBrowserState>>();

function defaultTabs(): WorkspaceBrowserTab[] {
  return [{ appKey: defaultBrowserAppKey, label: "Browser" }];
}

export function browserFrameId(workspaceId: string, appKey = defaultBrowserAppKey): string {
  return ["browser_frame", workspaceId, appKey].join("_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function browserTabKey(appKey = defaultBrowserAppKey): string {
  return appKey;
}

export function listWorkspaceBrowserTabs(workspaceId: string): WorkspaceBrowserTab[] {
  const existing = browserTabsByWorkspace.get(workspaceId);
  if (existing) return existing;
  const seeded = defaultTabs();
  browserTabsByWorkspace.set(workspaceId, seeded);
  return seeded;
}

export function createWorkspaceBrowserTab(workspaceId: string): WorkspaceBrowserTab {
  const existing = listWorkspaceBrowserTabs(workspaceId);
  const used = new Set(existing.map((tab) => tab.appKey));
  let index = existing.length + 1;
  let appKey = `browser-${index}`;
  while (used.has(appKey)) {
    index += 1;
    appKey = `browser-${index}`;
  }
  const tab = { appKey, label: `Browser ${index}` };
  existing.push(tab);
  browserTabsByWorkspace.set(workspaceId, existing);
  return tab;
}

export function deleteWorkspaceBrowserTab(workspaceId: string, appKey: string): void {
  if (appKey === defaultBrowserAppKey) return;
  browserTabsByWorkspace.set(workspaceId, listWorkspaceBrowserTabs(workspaceId).filter((tab) => tab.appKey !== appKey));
  browserStateByWorkspace.get(workspaceId)?.delete(appKey);
}

export function getWorkspaceBrowserState(workspaceId: string, appKey = defaultBrowserAppKey): WorkspaceBrowserState {
  let workspaceState = browserStateByWorkspace.get(workspaceId);
  if (!workspaceState) {
    workspaceState = new Map();
    browserStateByWorkspace.set(workspaceId, workspaceState);
  }
  let state = workspaceState.get(appKey);
  if (!state) {
    state = { targetUrl: defaultTargetUrl };
    workspaceState.set(appKey, state);
  }
  return state;
}

export function setWorkspaceBrowserTarget(workspaceId: string, appKey: string, input: string): WorkspaceBrowserState {
  const targetUrl = normalizeBrowserUrl(input);
  const state = { targetUrl };
  let workspaceState = browserStateByWorkspace.get(workspaceId);
  if (!workspaceState) {
    workspaceState = new Map();
    browserStateByWorkspace.set(workspaceId, workspaceState);
  }
  workspaceState.set(appKey, state);
  return state;
}

export function deleteWorkspaceBrowserState(workspaceId: string): void {
  browserTabsByWorkspace.delete(workspaceId);
  browserStateByWorkspace.delete(workspaceId);
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
