import type { JsonValue } from "@atelier/core";
import { createWorkspaceMetadataState } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const filesViewSchema = Type.Object({
  id: Type.String(),
  path: Type.Optional(Type.String({ pattern: "^/" })),
  line: Type.Optional(Type.Number()),
  column: Type.Optional(Type.Number()),
});
const filesViewsSchema = Type.Array(filesViewSchema);

export type FilesView = Static<typeof filesViewSchema>;
export const defaultFilesViewId = "workspace";

function parseFilesViews(value: JsonValue): FilesView[] {
  if (!Value.Check(filesViewsSchema, value)) throw new Error("invalid persisted Files Work views");
  return value;
}

const filesViews = createWorkspaceMetadataState("files-work-views.json", parseFilesViews, () => [{ id: defaultFilesViewId }]);

export function listFilesViews(workspaceId: string): FilesView[] {
  const views = filesViews.read(workspaceId);
  if (views.some((view) => view.id === defaultFilesViewId)) return views;
  const withDefault = [{ id: defaultFilesViewId }, ...views];
  filesViews.write(workspaceId, withDefault);
  return withDefault;
}

function requireFilesView(views: FilesView[], id: string): FilesView {
  const view = views.find((candidate) => candidate.id === id);
  if (!view) throw new Error(`Files view not found: ${id}`);
  return view;
}

export function filesView(workspaceId: string, id: string): FilesView {
  return requireFilesView(listFilesViews(workspaceId), id);
}

export function selectFilesViewFile(workspaceId: string, id: string, path: string, position: { line?: number; column?: number } = {}): FilesView {
  const views = listFilesViews(workspaceId);
  const view = requireFilesView(views, id);
  view.path = path;
  view.line = position.line;
  view.column = position.column;
  filesViews.write(workspaceId, views);
  return view;
}

export function createFilesView(workspaceId: string, path?: string): FilesView {
  const views = listFilesViews(workspaceId);
  const view: FilesView = { id: crypto.randomUUID() };
  if (path) view.path = path;
  views.push(view);
  filesViews.write(workspaceId, views);
  return view;
}

export function closeFilesView(workspaceId: string, id: string): void {
  filesViews.write(workspaceId, filesViews.read(workspaceId).filter((view) => view.id !== id));
}

export function deleteFilesViewState(workspaceId: string): void {
  filesViews.delete(workspaceId);
}
