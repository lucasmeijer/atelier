import { isJsonObject, type JsonValue } from "@atelier/core";
import { domId } from "@atelier/shared";
import { createWorkspaceMetadataState } from "@atelier/workspace";

export interface WorkspaceBrowserView {
  key: string;
  label: string;
  targetUrl: string;
}

function parseBrowserViews(value: JsonValue): WorkspaceBrowserView[] {
  if (!Array.isArray(value)) throw new Error("invalid persisted Browser Work views");
  return value.map((entry) => {
    if (!isJsonObject(entry) || typeof entry.key !== "string" || !/^browser-\d+$/.test(entry.key) || typeof entry.label !== "string" || typeof entry.targetUrl !== "string") {
      throw new Error("invalid persisted Browser Work view");
    }
    return { key: entry.key, label: entry.label, targetUrl: entry.targetUrl };
  });
}

const browserViews = createWorkspaceMetadataState("browser-work-views.json", parseBrowserViews, () => []);

export function browserFrameId(workspaceId: string, appKey: string): string {
  return domId("browser_frame", workspaceId, appKey);
}

export function listWorkspaceBrowserViews(workspaceId: string): WorkspaceBrowserView[] {
  return browserViews.read(workspaceId);
}

export function getWorkspaceBrowserView(workspaceId: string, appKey: string): WorkspaceBrowserView | undefined {
  return browserViews.read(workspaceId).find((view) => view.key === appKey);
}

export function createWorkspaceBrowserView(workspaceId: string): WorkspaceBrowserView {
  const existing = listWorkspaceBrowserViews(workspaceId);
  const used = new Set(existing.map((view) => view.key));
  let index = existing.length + 1;
  let key = `browser-${index}`;
  while (used.has(key)) {
    index += 1;
    key = `browser-${index}`;
  }
  const view = { key, label: `Browser ${index}`, targetUrl: "" };
  existing.push(view);
  browserViews.write(workspaceId, existing);
  return view;
}

export function deleteWorkspaceBrowserView(workspaceId: string, appKey: string): void {
  browserViews.write(workspaceId, browserViews.read(workspaceId).filter((view) => view.key !== appKey));
}

export function setWorkspaceBrowserTarget(workspaceId: string, appKey: string, input: string): WorkspaceBrowserView | undefined {
  const view = getWorkspaceBrowserView(workspaceId, appKey);
  if (!view) return undefined;
  view.targetUrl = normalizeBrowserUrl(input);
  browserViews.write(workspaceId, browserViews.read(workspaceId));
  return view;
}

export function deleteWorkspaceBrowserState(workspaceId: string): void {
  browserViews.delete(workspaceId);
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
