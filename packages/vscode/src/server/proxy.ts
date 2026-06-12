import { getWorkspaceVSCodePort } from "@atelier/core";
import type { WorkspaceAppHost } from "@atelier/workspace-proxy/server";
import { ensureWorkspaceVSCodeServer } from "./workspace-vscode.ts";

export const vscodeAppKey = "vscode";
export const vscodeContainerPort = 8000;

function publishedPortHost(): string {
  return process.env.ATELIER_DOCKER_PUBLISHED_PORT_HOST || "127.0.0.1";
}

export async function resolveVSCodeWorkspaceAppTarget(app: WorkspaceAppHost, requestUrl: URL): Promise<URL> {
  if (app.appKey !== vscodeAppKey) throw new Error(`unknown workspace app: ${app.appKey}`);
  await ensureWorkspaceVSCodeServer(app.workspaceId);
  const hostPort = await getWorkspaceVSCodePort(app.workspaceId);
  return new URL(requestUrl.pathname + requestUrl.search, `http://${publishedPortHost()}:${hostPort}`);
}
