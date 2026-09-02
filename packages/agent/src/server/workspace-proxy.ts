import { workspacePreviewPortUrl } from "@atelier/workspace";

export async function resolveWorkspacePortProxyTarget(workspaceId: string, port: number, path: string, search = ""): Promise<URL> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("bad port");
  return await workspacePreviewPortUrl(workspaceId, port, `${path.startsWith("/") ? path : `/${path}`}${search}`);
}
