import type { JsonValue } from "@atelier/core";
import { domId } from "@atelier/shared";
import { createWorkspaceMetadataState } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const workspaceBrowserViewSchema = Type.Object({
  key: Type.String({ pattern: "^browser-[a-zA-Z0-9-]+$" }),
  label: Type.String(),
  targetUrl: Type.String(),
});

const workspaceBrowserViewsSchema = Type.Array(workspaceBrowserViewSchema);

export type WorkspaceBrowserView = Static<typeof workspaceBrowserViewSchema>;

function parseBrowserViews(value: JsonValue): WorkspaceBrowserView[] {
  return Value.Parse(workspaceBrowserViewsSchema, Value.Clean(workspaceBrowserViewsSchema, value));
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
  const index = existing.length + 1;
  const view = { key: `browser-${crypto.randomUUID()}`, label: `Browser ${index}`, targetUrl: "" };
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
