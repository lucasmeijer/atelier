import type { AtelierEventBus } from "@atelier/core";
import { turboStream, turboStreamResponse, type WorkspaceModule } from "@atelier/shared";
import { renderMarkdown } from "@atelier/markdown";
import { EditorFileError, maxEditableFileBytes, readEditableFile, writeEditableFile } from "./file.ts";
import {
  closeWorkspaceFileEditorTab,
  deleteWorkspaceFileEditorState,
  fileEditorTabLabels,
  listWorkspaceFileEditorTabs,
  openWorkspaceFileEditorTab,
} from "./state.ts";
import { fileEditorSignalId, renderFileEditorSignal, renderFileEditorTab } from "./render.ts";

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

async function openEditorEndpoint(workspaceId: string, url: URL, openTab: (workspaceId: string, tabKey: string, placement: "preview-group") => Promise<Response>): Promise<Response> {
  const file = await readEditableFile(workspaceId, url.searchParams.get("path"));
  const line = positiveInteger(url.searchParams.get("line"));
  const column = positiveInteger(url.searchParams.get("column"));
  const { tab, created } = openWorkspaceFileEditorTab(workspaceId, file.path, { line, column });
  if (created) return await openTab(workspaceId, tab.key, "preview-group");
  return turboStreamResponse(turboStream("replace", fileEditorSignalId(workspaceId), renderFileEditorSignal(workspaceId, { tabKey: tab.key, line, column })));
}

async function markdownPreviewEndpoint(workspaceId: string, request: Request): Promise<Response> {
  if (request.method !== "POST") return textResponse("Method not allowed", 405);
  return new Response(renderMarkdown(workspaceId, await request.text()), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function editorContentEndpoint(workspaceId: string, request: Request, url: URL): Promise<Response> {
  const path = url.searchParams.get("path");
  if (request.method === "GET") return jsonResponse(await readEditableFile(workspaceId, path));
  if (request.method !== "PUT") return textResponse("Method not allowed", 405);
  const body = await request.json() as { content?: unknown; revision?: unknown; force?: unknown };
  if (typeof body.content !== "string" || typeof body.revision !== "string") return textResponse("Invalid editor save", 422);
  try {
    return jsonResponse({ revision: await writeEditableFile(workspaceId, path, body.content, body.revision, body.force === true) });
  } catch (error) {
    if (error instanceof EditorFileError && error.status === 409) return jsonResponse(await readEditableFile(workspaceId, path), 409);
    throw error;
  }
}

const editorWorkspaceModule: WorkspaceModule = {
  id: "editor",
  staticFiles: {
    "/editor.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  },
  routes: [{
    async handle(request, url, context) {
      try {
        const match = url.pathname.match(/^\/workspaces\/([^/]+)\/file-editor\/(open|content|markdown-preview)$/);
        if (!match) return undefined;
        const workspaceId = decodeURIComponent(match[1]!);
        if (match[2] === "open") return request.method === "GET" ? await openEditorEndpoint(workspaceId, url, context.openTab) : textResponse("Method not allowed", 405);
        if (match[2] === "markdown-preview") return await markdownPreviewEndpoint(workspaceId, request);
        return await editorContentEndpoint(workspaceId, request, url);
      } catch (error) {
        if (error instanceof EditorFileError) return textResponse(error.message, error.status);
        throw error;
      }
    },
  }],
  initialize(context) {
    const events = context.events as AtelierEventBus;
    events.on("workspace_agent_turn_finished", ({ workspaceId }) => {
      if (listWorkspaceFileEditorTabs(workspaceId).length === 0) return;
      context.broadcastWorkspace(workspaceId, turboStream("replace", fileEditorSignalId(workspaceId), renderFileEditorSignal(workspaceId)));
    });
    context.onWorkspaceRemoved((workspaceId) => deleteWorkspaceFileEditorState(workspaceId));
  },
  tabs: [{
    owns: (tabKey) => tabKey.startsWith("file-editor:"),
    close: ({ workspaceId, tabKey }) => closeWorkspaceFileEditorTab(workspaceId, tabKey),
  }],
  attachToWorkspace({ workspaceId }) {
    const editorTabs = listWorkspaceFileEditorTabs(workspaceId);
    const labels = fileEditorTabLabels(editorTabs);
    return {
      tabs: editorTabs.map((tab) => renderFileEditorTab(workspaceId, tab, labels.get(tab.key)!)),
      workspaceChromeHtml: [renderFileEditorSignal(workspaceId)],
    };
  },
};

export { maxEditableFileBytes, editorWorkspaceModule as atelierServerModule };
