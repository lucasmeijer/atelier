import type { JsonValue } from "@atelier/core";
import { renderMarkdown } from "@atelier/markdown";
import { turboStream, turboStreamResponse, type WorkspaceModule, type WorkspaceWorkViewReference } from "@atelier/shared";
import { workspaceRoot } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { fileSaveRequestSchema, type FileSaveRequest } from "../protocol.ts";
import { EditableFileError, readEditableFile, requestedEditableFilePath, writeEditableFile } from "./editable-file.ts";
import { deleteFile, FilesPathError, getDirectoryEntry, listFiles, searchFiles, uploadFile } from "./files.ts";
import { filesEditorFrameId, filesRefreshSignalId, filesTreeFrameId, renderFilesDirectoryFrame, renderFilesEditorFrame, renderFilesRefreshSignal, renderFilesTreeFrame, renderFilesTreeResultsFrame, filesWorkViewPresentation, renderFilesWorkViewBody, renderLazyFilesTreeFrame } from "./render.ts";
import { closeFilesView, createFilesView, defaultFilesViewId, deleteFilesViewState, filesView, listFilesViews, setFilesViewFile } from "./state.ts";

const filesWorkViewReferenceSchema = Type.Object({ type: Type.Literal("files"), id: Type.String() });
type FilesWorkViewReference = Static<typeof filesWorkViewReferenceSchema>;

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function jsonResponse<Body extends object>(value: Body, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function positiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function filesEndpoint(workspaceId: string, url: URL): Promise<Response> {
  const viewId = url.searchParams.get("filesView") ?? defaultFilesViewId;
  const filesState = filesView(workspaceId, viewId);
  const query = url.searchParams.get("q");
  if (query !== null) {
    const normalizedQuery = query.trim();
    const selectedPath = filesState.path;
    const entries = normalizedQuery ? await searchFiles(workspaceId, normalizedQuery) : (await listFiles(workspaceId, workspaceRoot, selectedPath)).entries;
    return htmlResponse(renderFilesTreeResultsFrame(workspaceId, viewId, entries, selectedPath, Boolean(normalizedQuery)));
  }
  const view = url.searchParams.get("view");
  if (view === "inline" || view === "collapsed") {
    const entry = await getDirectoryEntry(workspaceId, url.searchParams.get("path"));
    const listing = view === "inline" ? await listFiles(workspaceId, entry.directoryPath ?? entry.path) : undefined;
    return htmlResponse(renderFilesDirectoryFrame(workspaceId, viewId, entry, listing?.entries, filesState.path));
  }
  const listing = await listFiles(workspaceId, workspaceRoot, filesState.path);
  return htmlResponse(renderFilesTreeFrame(workspaceId, viewId, listing.entries, filesState.path));
}

async function openFileEndpoint(workspaceId: string, url: URL, openWorkView: (workspaceId: string, reference: WorkspaceWorkViewReference) => Promise<Response>): Promise<Response> {
  const path = requestedEditableFilePath(url.searchParams.get("path"));
  const viewId = url.searchParams.get("filesView") ?? defaultFilesViewId;
  const view = setFilesViewFile(workspaceId, viewId, path, { line: positiveInteger(url.searchParams.get("line")), column: positiveInteger(url.searchParams.get("column")) });
  const updates = turboStream("replace", filesEditorFrameId(workspaceId, viewId), renderFilesEditorFrame(workspaceId, view))
    + turboStream("replace", filesTreeFrameId(workspaceId, viewId), renderLazyFilesTreeFrame(workspaceId, view));
  if (url.searchParams.has("filesView")) return turboStreamResponse(updates);
  const presentation = await openWorkView(workspaceId, { type: "files", id: viewId });
  return turboStreamResponse(`${await presentation.text()}${updates}`);
}

async function markdownPreviewEndpoint(workspaceId: string, request: Request, url: URL): Promise<Response> {
  if (request.method !== "POST") return textResponse("Method not allowed", 405);
  const sourcePath = url.searchParams.get("path");
  const options = sourcePath?.startsWith("/") ? { sourcePath } : {};
  return new Response(renderMarkdown(workspaceId, await request.text(), options), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function fileContentEndpoint(workspaceId: string, request: Request, url: URL): Promise<Response> {
  const path = url.searchParams.get("path");
  if (request.method === "GET") return jsonResponse(await readEditableFile(workspaceId, path));
  if (request.method !== "PUT") return textResponse("Method not allowed", 405);
  const body: unknown = await request.json();
  if (!Value.Check(fileSaveRequestSchema, body)) return textResponse("Invalid file save", 422);
  const save: FileSaveRequest = body;
  try {
    return jsonResponse({ revision: await writeEditableFile(workspaceId, path, save.content, save.revision, save.force === true) });
  } catch (error) {
    if (error instanceof EditableFileError && error.status === 409) return jsonResponse(await readEditableFile(workspaceId, path), 409);
    throw error;
  }
}

async function uploadEndpoint(workspaceId: string, request: Request, url: URL): Promise<Response> {
  const content = new Uint8Array(await request.arrayBuffer());
  await uploadFile(workspaceId, url.searchParams.get("destination"), url.searchParams.get("name"), url.searchParams.get("overwrite") === "1", content);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function deleteEndpoint(workspaceId: string, request: Request): Promise<Response> {
  const form = await request.formData();
  const viewId = String(form.get("filesView") ?? defaultFilesViewId);
  await deleteFile(workspaceId, String(form.get("path") ?? ""));
  const view = setFilesViewFile(workspaceId, viewId);
  const listing = await listFiles(workspaceId, workspaceRoot);
  return turboStreamResponse(
    turboStream("replace", filesTreeFrameId(workspaceId, viewId), renderFilesTreeFrame(workspaceId, viewId, listing.entries))
    + turboStream("replace", filesEditorFrameId(workspaceId, viewId), renderFilesEditorFrame(workspaceId, view)),
  );
}

const filesWorkspaceModule: WorkspaceModule = {
  id: "files",
  workViews: [{
    type: "files",
    parseReference(value: JsonValue) {
      if (!Value.Check(filesWorkViewReferenceSchema, value)) throw new Error("Files reference requires an id");
      return { type: value.type, id: value.id };
    },
    identity: (reference: FilesWorkViewReference) => reference.id,
    render: ({ workspaceId, reference }: { workspaceId: string; reference: FilesWorkViewReference }) => renderFilesWorkViewBody(workspaceId, filesView(workspaceId, reference.id)),
    close: ({ workspaceId, reference }: { workspaceId: string; reference: FilesWorkViewReference }) => closeFilesView(workspaceId, reference.id),
  }],
  commands: [{ id: "files.create", execute: ({ workspaceId }) => ({ createdWorkView: { type: "files", id: createFilesView(workspaceId).id } }) }],
  staticFiles: { "/files.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  routes: [{
    async handle(request, url, context) {
      try {
        let match = url.pathname.match(/^\/workspaces\/([^/]+)\/files-view\/(open|content|markdown-preview)$/);
        if (match) {
          const workspaceId = decodeURIComponent(match[1]!);
          if (match[2] === "open") return request.method === "GET" ? await openFileEndpoint(workspaceId, url, context.openWorkView) : textResponse("Method not allowed", 405);
          if (match[2] === "content") return await fileContentEndpoint(workspaceId, request, url);
          return await markdownPreviewEndpoint(workspaceId, request, url);
        }

        match = url.pathname.match(/^\/workspaces\/([^/]+)\/files$/);
        if (match) return request.method === "GET" ? await filesEndpoint(decodeURIComponent(match[1]!), url) : textResponse("Method not allowed", 405);

        match = url.pathname.match(/^\/workspaces\/([^/]+)\/file-browser\/(upload|delete)$/);
        if (!match) return undefined;
        const workspaceId = decodeURIComponent(match[1]!);
        if (match[2] === "upload") return request.method === "POST" ? await uploadEndpoint(workspaceId, request, url) : textResponse("Method not allowed", 405);
        return request.method === "POST" ? await deleteEndpoint(workspaceId, request) : textResponse("Method not allowed", 405);
      } catch (error) {
        if (error instanceof FilesPathError || error instanceof EditableFileError) return textResponse(error.message, error.status);
        throw error;
      }
    },
  }],
  initialize(context) {
    context.events.on("workspace_agent_turn_finished", ({ workspaceId }) => {
      if (!listFilesViews(workspaceId).some((view) => view.path)) return;
      context.broadcastWorkspace(workspaceId, turboStream("replace", filesRefreshSignalId(workspaceId), renderFilesRefreshSignal(workspaceId)));
    });
    context.onWorkspaceRemoved((workspaceId) => deleteFilesViewState(workspaceId));
  },
  attachToWorkspace({ workspaceId }) {
    return {
      workViews: listFilesViews(workspaceId).map(filesWorkViewPresentation),
      commands: [{ id: "files.create", label: "New Files view", scope: "workspace", surfaces: { ui: { placement: "work-launcher", label: "Files" } } }],
      overlayHtml: [renderFilesRefreshSignal(workspaceId)],
    };
  },
};

export { filesWorkspaceModule as atelierServerModule };
