import { getWorkspaceDesktopPort } from "@atelier/workspace";
import type { WorkspaceAppHost } from "@atelier/workspace-proxy/server";
import { desktopAppKey, ensureWorkspaceDesktop } from "./runtime.ts";

function publishedPortHost(): string {
  return process.env.ATELIER_DOCKER_PUBLISHED_PORT_HOST || "127.0.0.1";
}

export async function resolveDesktopWorkspaceAppTarget(app: WorkspaceAppHost, requestUrl: URL): Promise<URL> {
  if (app.appKey !== desktopAppKey) throw new Error(`unknown workspace app: ${app.appKey}`);
  await ensureWorkspaceDesktop(app.workspaceId);
  const hostPort = await getWorkspaceDesktopPort(app.workspaceId);
  return new URL(requestUrl.pathname + requestUrl.search, `http://${publishedPortHost()}:${hostPort}`);
}
