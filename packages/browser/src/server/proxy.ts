import { getWorkspacePreviewPort, workspaceContainerName, workspacePreviewPorts } from "@atelier/workspace";
import type { WorkspaceAppHost } from "@atelier/workspace-proxy/server";
import { getWorkspaceBrowserState } from "./state.ts";

export const browserAppKey = "browser";

function publishedPortHost(): string {
  return process.env.ATELIER_DOCKER_PUBLISHED_PORT_HOST || "127.0.0.1";
}

function useWorkspaceDockerNetwork(): boolean {
  return Boolean(process.env.ATELIER_WORKSPACE_DOCKER_NETWORK);
}

export function isBrowserWorkspaceApp(appKey: string): boolean {
  return appKey === browserAppKey || /^browser-\d+$/.test(appKey);
}

export async function resolveBrowserWorkspaceAppTarget(app: WorkspaceAppHost, requestUrl: URL): Promise<URL> {
  if (!isBrowserWorkspaceApp(app.appKey)) throw new Error(`unknown workspace app: ${app.appKey}`);
  const targetBase = new URL(getWorkspaceBrowserState(app.workspaceId, app.appKey).targetUrl);
  const target = new URL(requestUrl.pathname + requestUrl.search, targetBase);

  if (!isLoopbackHost(target.hostname)) return target;

  const containerPort = Number(target.port || defaultPortForProtocol(target.protocol));
  if (!Number.isInteger(containerPort) || !(workspacePreviewPorts as readonly number[]).includes(containerPort)) {
    throw new Error(`Port ${target.port || defaultPortForProtocol(target.protocol)} is not published for browser previews. Use one of: ${workspacePreviewPorts.join(", ")}`);
  }

  if (useWorkspaceDockerNetwork()) {
    await getWorkspacePreviewPort(app.workspaceId, containerPort);
    return new URL(`${target.protocol}//${workspaceContainerName(app.workspaceId)}:${containerPort}${target.pathname}${target.search}`);
  }

  const hostPort = await getWorkspacePreviewPort(app.workspaceId, containerPort);
  return new URL(`${target.protocol}//${publishedPortHost()}:${hostPort}${target.pathname}${target.search}`);
}

function defaultPortForProtocol(protocol: string): number {
  if (protocol === "https:") return 443;
  return 80;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}
