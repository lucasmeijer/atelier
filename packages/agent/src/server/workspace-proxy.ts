import type { WorkspaceHttpAppBackend } from "@atelier/shared";
import { workspacePortBackend } from "@atelier/workspace";

export async function resolveWorkspacePortProxyBackend(workspaceId: string, port: number, path: string, search = ""): Promise<WorkspaceHttpAppBackend> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("bad port");
  return await workspacePortBackend(workspaceId, port, `${path.startsWith("/") ? path : `/${path}`}${search}`);
}
