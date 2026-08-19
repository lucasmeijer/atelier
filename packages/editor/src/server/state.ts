import { posix } from "node:path";
import type { JsonValue } from "@atelier/core";
import { createWorkspaceMetadataState } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const workspaceFileEditorViewSchema = Type.Object({
  key: Type.String(),
  path: Type.String({ pattern: "^/" }),
  line: Type.Optional(Type.Number()),
  column: Type.Optional(Type.Number()),
});
const workspaceFileEditorViewsSchema = Type.Array(workspaceFileEditorViewSchema);

export type WorkspaceFileEditorView = Static<typeof workspaceFileEditorViewSchema>;

export interface OpenWorkspaceFileEditorViewResult {
  view: WorkspaceFileEditorView;
  created: boolean;
}

function parseFileViews(value: JsonValue): WorkspaceFileEditorView[] {
  if (!Value.Check(workspaceFileEditorViewsSchema, value)) throw new Error("invalid persisted File Work views");
  return value;
}

const fileViews = createWorkspaceMetadataState("file-work-views.json", parseFileViews, () => []);

function viewKey(path: string): string {
  return `file-editor:${Buffer.from(path).toString("base64url")}`;
}

export function listWorkspaceFileEditorViews(workspaceId: string): WorkspaceFileEditorView[] {
  return fileViews.read(workspaceId);
}

export function openWorkspaceFileEditorView(workspaceId: string, path: string, position: { line?: number; column?: number } = {}): OpenWorkspaceFileEditorViewResult {
  const views = fileViews.read(workspaceId);
  const existing = views.find((view) => view.path === path);
  if (existing) {
    existing.line = position.line;
    existing.column = position.column;
    fileViews.write(workspaceId, views);
    return { view: existing, created: false };
  }
  const view = { key: viewKey(path), path, ...position };
  views.push(view);
  fileViews.write(workspaceId, views);
  return { view, created: true };
}

export function closeWorkspaceFileEditorView(workspaceId: string, key: string): void {
  fileViews.write(workspaceId, fileViews.read(workspaceId).filter((view) => view.key !== key));
}

export function deleteWorkspaceFileEditorState(workspaceId: string): void {
  fileViews.delete(workspaceId);
}

export function fileEditorViewLabels(views: WorkspaceFileEditorView[]): Map<string, string> {
  const basenameCounts = new Map<string, number>();
  for (const view of views) {
    const basename = posix.basename(view.path);
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }
  return new Map(views.map((view) => {
    const basename = posix.basename(view.path);
    const label = (basenameCounts.get(basename) ?? 0) > 1 ? `${posix.basename(posix.dirname(view.path))}/${basename}` : basename;
    return [view.key, label];
  }));
}
