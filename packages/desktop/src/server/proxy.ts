import { getWorkspaceDesktopPort, workspaceContainerName, workspaceDesktopPort } from "@atelier/workspace";
import type { WorkspaceAppHost } from "@atelier/workspace-proxy/server";
import { desktopAppKey, ensureWorkspaceDesktop } from "./runtime.ts";

function publishedPortHost(): string {
  return process.env.ATELIER_DOCKER_PUBLISHED_PORT_HOST || "127.0.0.1";
}

function useWorkspaceDockerNetwork(): boolean {
  return Boolean(process.env.ATELIER_WORKSPACE_DOCKER_NETWORK);
}

export async function resolveDesktopWorkspaceAppTarget(app: WorkspaceAppHost, requestUrl: URL): Promise<URL> {
  if (app.appKey !== desktopAppKey) throw new Error(`unknown workspace app: ${app.appKey}`);
  await ensureWorkspaceDesktop(app.workspaceId);
  const path = requestUrl.pathname + requestUrl.search;
  if (useWorkspaceDockerNetwork()) return new URL(path, `http://${workspaceContainerName(app.workspaceId)}:${workspaceDesktopPort}`);
  const hostPort = await getWorkspaceDesktopPort(app.workspaceId);
  return new URL(path, `http://${publishedPortHost()}:${hostPort}`);
}
