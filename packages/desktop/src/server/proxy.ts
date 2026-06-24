import { workspaceDesktopPort, workspacePortUrl } from "@atelier/workspace";
import type { WorkspaceAppHost } from "@atelier/proxy-ingress/server";
import { desktopAppKey, ensureWorkspaceDesktop } from "./runtime.ts";

export async function resolveDesktopWorkspaceAppTarget(app: WorkspaceAppHost, requestUrl: URL): Promise<URL> {
  if (app.appKey !== desktopAppKey) throw new Error(`unknown workspace app: ${app.appKey}`);
  await ensureWorkspaceDesktop(app.workspaceId);
  const path = requestUrl.pathname + requestUrl.search;
  return await workspacePortUrl(app.workspaceId, workspaceDesktopPort, path);
}
