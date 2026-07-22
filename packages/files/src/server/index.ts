import type { WorkspaceModule } from "@atelier/shared";
import { workspaceRoot } from "@atelier/workspace";
import { FilesPathError, listFiles, uploadFile } from "./files.ts";
import { renderFilesFrame, renderFilesTab } from "./render.ts";

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

async function filesEndpoint(workspaceId: string, url: URL): Promise<Response> {
  const showConcealed = url.searchParams.get("showHidden") === "1";
  const listing = await listFiles(workspaceId, url.searchParams.get("path"), showConcealed);
  return new Response(renderFilesFrame(workspaceId, listing.path, listing.entries, showConcealed), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function uploadEndpoint(workspaceId: string, request: Request, url: URL): Promise<Response> {
  const content = new Uint8Array(await request.arrayBuffer());
  await uploadFile(workspaceId, url.searchParams.get("destination"), url.searchParams.get("name"), url.searchParams.get("overwrite") === "1", content);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

const filesWorkspaceModule: WorkspaceModule = {
  id: "files",
  staticFiles: {
    "/files.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  },
  routes: [{
    async handle(request, url) {
      try {
        let match = url.pathname.match(/^\/workspaces\/([^/]+)\/files$/);
        if (match) return request.method === "GET" ? await filesEndpoint(decodeURIComponent(match[1]!), url) : textResponse("Method not allowed", 405);

        match = url.pathname.match(/^\/workspaces\/([^/]+)\/file-browser\/upload$/);
        if (!match) return undefined;
        return request.method === "POST" ? await uploadEndpoint(decodeURIComponent(match[1]!), request, url) : textResponse("Method not allowed", 405);
      } catch (error) {
        if (error instanceof FilesPathError) return textResponse(error.message, error.status);
        throw error;
      }
    },
  }],
  async attachToWorkspace({ workspaceId }) {
    const listing = await listFiles(workspaceId, workspaceRoot, false);
    return { tabs: [renderFilesTab(renderFilesFrame(workspaceId, listing.path, listing.entries, false))] };
  },
};

export { filesWorkspaceModule as atelierServerModule };
