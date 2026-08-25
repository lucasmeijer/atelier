import type { AtelierEventBus, JsonValue } from "@atelier/core";
import { renderMarkdown } from "@atelier/markdown";
import { turboStream, turboStreamResponse, type WorkspaceModule } from "@atelier/shared";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { isEditorSaveRequest } from "../protocol.ts";
import { EditorFileError, maxEditableFileBytes, readEditableFile, requestedEditableFilePath, writeEditableFile } from "./file.ts";
import { fileEditorSignalId, renderFileEditorSignal, renderFileWorkView } from "./render.ts";
import {
  closeWorkspaceFileEditorView,
  deleteWorkspaceFileEditorState,
  fileEditorViewLabels,
  listWorkspaceFileEditorViews,
  openWorkspaceFileEditorView,
} from "./state.ts";

const fileWorkViewReferenceSchema = Type.Object({
  type: Type.Literal("file"),
  path: Type.String({ pattern: "^/" }),
});

type FileWorkViewReference = Static<typeof fileWorkViewReferenceSchema>;

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function jsonResponse<Body extends object>(value: Body, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function positiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function openEditorEndpoint(workspaceId: string, url: URL, openWorkView: (workspaceId: string, reference: FileWorkViewReference) => Promise<Response>): Promise<Response> {
  const path = requestedEditableFilePath(url.searchParams.get("path"));
  const line = positiveInteger(url.searchParams.get("line"));
  const column = positiveInteger(url.searchParams.get("column"));
  const { view } = openWorkspaceFileEditorView(workspaceId, path, { line, column });
  return await openWorkView(workspaceId, { type: "file", path: view.path });
}

async function markdownPreviewEndpoint(workspaceId: string, request: Request, url: URL): Promise<Response> {
  if (request.method !== "POST") return textResponse("Method not allowed", 405);
  const sourcePath = url.searchParams.get("path");
  const options = sourcePath?.startsWith("/") ? { sourcePath } : {};
  return new Response(renderMarkdown(workspaceId, await request.text(), options), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function editorContentEndpoint(workspaceId: string, request: Request, url: URL): Promise<Response> {
  const path = url.searchParams.get("path");
  if (request.method === "GET") return jsonResponse(await readEditableFile(workspaceId, path));
  if (request.method !== "PUT") return textResponse("Method not allowed", 405);
  const body = await request.json();
  if (!isEditorSaveRequest(body)) return textResponse("Invalid editor save", 422);
  try {
    return jsonResponse({ revision: await writeEditableFile(workspaceId, path, body.content, body.revision, body.force === true) });
  } catch (error) {
    if (error instanceof EditorFileError && error.status === 409) return jsonResponse(await readEditableFile(workspaceId, path), 409);
    throw error;
  }
}

const editorWorkspaceModule: WorkspaceModule = {
  id: "editor",
  workViews: [{
    type: "file",
    parseReference(value: JsonValue) {
      if (!Value.Check(fileWorkViewReferenceSchema, value)) throw new Error("path must be absolute");
      return { type: value.type, path: value.path };
    },
    identity: (reference: FileWorkViewReference) => reference.path,
    close: ({ workspaceId, reference }: { workspaceId: string; reference: FileWorkViewReference }) => closeWorkspaceFileEditorView(workspaceId, `file-editor:${Buffer.from(reference.path).toString("base64url")}`),
  }],
  staticFiles: {
    "/editor.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  },
  routes: [{
    async handle(request, url, context) {
      try {
        const match = url.pathname.match(/^\/workspaces\/([^/]+)\/file-editor\/(open|content|markdown-preview)$/);
        if (!match) return undefined;
        const workspaceId = decodeURIComponent(match[1]!);
        if (match[2] === "open") return request.method === "GET" ? await openEditorEndpoint(workspaceId, url, context.openWorkView) : textResponse("Method not allowed", 405);
        if (match[2] === "markdown-preview") return await markdownPreviewEndpoint(workspaceId, request, url);
        return await editorContentEndpoint(workspaceId, request, url);
      } catch (error) {
        if (error instanceof EditorFileError) return textResponse(error.message, error.status);
        throw error;
      }
    },
  }],
  initialize(context) {
    // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
    const events = context.events as AtelierEventBus;
    events.on("workspace_agent_turn_finished", ({ workspaceId }) => {
      if (listWorkspaceFileEditorViews(workspaceId).length === 0) return;
      context.broadcastWorkspace(workspaceId, turboStream("replace", fileEditorSignalId(workspaceId), renderFileEditorSignal(workspaceId)));
    });
    context.onWorkspaceRemoved((workspaceId) => deleteWorkspaceFileEditorState(workspaceId));
  },
  attachToWorkspace({ workspaceId }) {
    const editorViews = listWorkspaceFileEditorViews(workspaceId);
    const labels = fileEditorViewLabels(editorViews);
    return {
      workViews: editorViews.map((view) => renderFileWorkView(workspaceId, view, labels.get(view.key)!)),
      overlayHtml: [renderFileEditorSignal(workspaceId)],
    };
  },
};

export { maxEditableFileBytes, editorWorkspaceModule as atelierServerModule };
