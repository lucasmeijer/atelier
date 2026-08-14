import { posix } from "node:path";
import type { WorkspaceModule } from "@atelier/shared";
import { workspaceContainerName, workspaceRoot } from "@atelier/workspace";
import { deleteFile, FilesPathError, listFiles, resolveFilesDirectory, uploadFile } from "./files.ts";
import { renderFilesDirectoryFrame, renderFilesFrame, renderFilesTab, renderLazyFilesFrame } from "./render.ts";

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function filesResponse(workspaceId: string, path: string | null, showConcealed: boolean): Promise<Response> {
  const listing = await listFiles(workspaceId, path, showConcealed);
  return htmlResponse(renderFilesFrame(workspaceId, listing.path, listing.entries, showConcealed));
}

async function filesEndpoint(workspaceId: string, url: URL): Promise<Response> {
  const showConcealed = url.searchParams.get("showHidden") === "1";
  const view = url.searchParams.get("view");
  if (view === "inline" || view === "collapsed") {
    const listing = view === "inline" ? await listFiles(workspaceId, url.searchParams.get("path"), showConcealed) : undefined;
    const path = listing?.path ?? await resolveFilesDirectory(workspaceId, url.searchParams.get("path"));
    const entry = {
      name: posix.basename(path),
      path,
      kind: "directory" as const,
      size: 0,
      concealed: url.searchParams.get("concealed") === "1",
      openable: false,
    };
    return htmlResponse(renderFilesDirectoryFrame(workspaceId, entry, showConcealed, listing?.entries));
  }
  return await filesResponse(workspaceId, url.searchParams.get("path"), showConcealed);
}

async function uploadEndpoint(workspaceId: string, request: Request, url: URL): Promise<Response> {
  const content = new Uint8Array(await request.arrayBuffer());
  await uploadFile(workspaceId, url.searchParams.get("destination"), url.searchParams.get("name"), url.searchParams.get("overwrite") === "1", content);
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function deleteEndpoint(workspaceId: string, request: Request): Promise<Response> {
  const form = await request.formData();
  const path = await deleteFile(workspaceId, String(form.get("path") ?? ""));
  return await filesResponse(workspaceId, path, form.get("showHidden") === "1");
}

function encodedFilename(name: string): string {
  return encodeURIComponent(name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function archiveEndpoint(workspaceId: string, url: URL): Promise<Response> {
  const path = await resolveFilesDirectory(workspaceId, url.searchParams.get("path"));
  const name = posix.basename(path);
  const archiveName = `${name}.tar.gz`;
  const fallbackName = archiveName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const process = Bun.spawn(["docker", "exec", workspaceContainerName(workspaceId), "tar", "-czf", "-", "-C", posix.dirname(path), "--", name], { stdout: "pipe", stderr: "ignore" });
  return new Response(process.stdout, { headers: {
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedFilename(archiveName)}`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  } });
}

const filesWorkspaceModule: WorkspaceModule = {
  id: "files",
  workViews: [{
    type: "files",
    parseReference(value: unknown) {
      const reference = value as { type?: unknown };
      if (reference?.type !== "files" || Object.keys(reference).length !== 1) throw new Error("Files reference has no identity fields");
      return { type: "files" };
    },
    identity: () => "workspace",
  }],
  staticFiles: {
    "/files.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  },
  routes: [{
    async handle(request, url) {
      try {
        let match = url.pathname.match(/^\/workspaces\/([^/]+)\/files$/);
        if (match) return request.method === "GET" ? await filesEndpoint(decodeURIComponent(match[1]!), url) : textResponse("Method not allowed", 405);

        match = url.pathname.match(/^\/workspaces\/([^/]+)\/file-browser\/(upload|delete|archive)$/);
        if (!match) return undefined;
        const workspaceId = decodeURIComponent(match[1]!);
        if (match[2] === "upload") return request.method === "POST" ? await uploadEndpoint(workspaceId, request, url) : textResponse("Method not allowed", 405);
        if (match[2] === "delete") return request.method === "POST" ? await deleteEndpoint(workspaceId, request) : textResponse("Method not allowed", 405);
        return request.method === "GET" ? await archiveEndpoint(workspaceId, url) : textResponse("Method not allowed", 405);
      } catch (error) {
        if (error instanceof FilesPathError) return textResponse(error.message, error.status);
        throw error;
      }
    },
  }],
  attachToWorkspace({ workspaceId }) {
    return { tabs: [renderFilesTab(renderLazyFilesFrame(workspaceId))] };
  },
};

export { filesWorkspaceModule as atelierServerModule };
