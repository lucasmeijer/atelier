import { getWorkspacePreviewPort, workspaceContainerName, workspacePreviewPorts } from "@atelier/workspace";
import { publicWorkspaceAppOrigin, type WorkspaceAppHost } from "@atelier/workspace-proxy/server";
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

export async function patchBrowserWorkspaceAppResponse(app: WorkspaceAppHost, response: Response, request: Request): Promise<Response> {
  if (!isBrowserWorkspaceApp(app.appKey)) return response;

  const publicOrigin = publicWorkspaceAppOrigin(request);
  const headers = new Headers(response.headers);
  const location = headers.get("location");
  const rewrittenLocation = location ? rewriteContainerLocalUrl(location, publicOrigin) : undefined;
  if (rewrittenLocation && rewrittenLocation !== location) headers.set("location", rewrittenLocation);

  const isHtml = headers.get("content-type")?.toLowerCase().includes("text/html") ?? false;
  if (!isHtml) {
    return rewrittenLocation && rewrittenLocation !== location ? new Response(response.body, { status: response.status, statusText: response.statusText, headers }) : response;
  }

  const text = await response.text();
  const rewritten = rewriteContainerLocalUrlsInHtml(text, publicOrigin);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(rewritten, { status: response.status, statusText: response.statusText, headers });
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

function rewriteContainerLocalUrlsInHtml(html: string, publicOrigin: string): string {
  return html.replace(/https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?([^\s"'<>)]*)/gi, (raw) => rewriteContainerLocalUrl(raw, publicOrigin));
}

function rewriteContainerLocalUrl(raw: string, publicOrigin: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (!isLoopbackHost(url.hostname)) return raw;
  const port = Number(url.port || defaultPortForProtocol(url.protocol));
  if (!Number.isInteger(port) || !(workspacePreviewPorts as readonly number[]).includes(port)) return raw;
  return new URL(`${url.pathname}${url.search}${url.hash}`, publicOrigin).toString();
}
