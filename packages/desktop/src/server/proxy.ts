import { getWorkspaceDesktopPort, shouldAddressWorkspaceContainersDirectly, workspaceContainerName, workspaceDesktopPort, workspacePublishedPortHost } from "@atelier/workspace";
import type { WorkspaceAppHost } from "@atelier/workspace-proxy/server";
import { desktopAppKey, ensureWorkspaceDesktop } from "./runtime.ts";

export async function resolveDesktopWorkspaceAppTarget(app: WorkspaceAppHost, requestUrl: URL): Promise<URL> {
  if (app.appKey !== desktopAppKey) throw new Error(`unknown workspace app: ${app.appKey}`);
  await ensureWorkspaceDesktop(app.workspaceId);
  const path = requestUrl.pathname + requestUrl.search;
  if (await shouldAddressWorkspaceContainersDirectly()) return new URL(path, `http://${workspaceContainerName(app.workspaceId)}:${workspaceDesktopPort}`);
  const hostPort = await getWorkspaceDesktopPort(app.workspaceId);
  return new URL(path, `http://${await workspacePublishedPortHost()}:${hostPort}`);
}
