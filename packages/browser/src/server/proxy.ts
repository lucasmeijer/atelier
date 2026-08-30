import { isWorkspacePreviewPort, workspacePreviewPortUrl, workspacePreviewPorts } from "@atelier/workspace";
import { nestedWorkspaceProxyRedirectHeader, publicWorkspaceAppOrigin, type WorkspaceAppHost } from "@atelier/proxy-ingress/server";
import { getWorkspaceBrowserView, setWorkspaceBrowserTarget, type WorkspaceBrowserView } from "./state.ts";
import { browserOriginParam, browserProxyUrl, stripBrowserProxyParams } from "../shared.ts";

export function isBrowserWorkspaceApp(workspaceId: string, appKey: string): boolean {
  return Boolean(getWorkspaceBrowserView(workspaceId, appKey));
}

export async function patchBrowserWorkspaceAppResponse(app: WorkspaceAppHost, response: Response, request: Request): Promise<Response> {
  const browserView = getWorkspaceBrowserView(app.workspaceId, app.appKey);
  if (!browserView) return response;
  const headers = new Headers(response.headers);
  if (headers.has(nestedWorkspaceProxyRedirectHeader)) {
    headers.delete(nestedWorkspaceProxyRedirectHeader);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  const requestUrl = new URL(request.url);
  const requestTarget = browserRequestTarget(browserView, requestUrl);
  const publicOrigin = publicWorkspaceAppOrigin(request);
  const location = headers.get("location");
  if (location) headers.set("location", rewriteBrowserRedirect(app, requestUrl, requestTarget, location, publicOrigin));

  const isHtml = headers.get("content-type")?.toLowerCase().includes("text/html") ?? false;
  if (!isHtml) {
    return location ? new Response(response.body, { status: response.status, statusText: response.statusText, headers }) : response;
  }

  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function resolveBrowserWorkspaceAppTarget(app: WorkspaceAppHost, requestUrl: URL): Promise<URL> {
  const browserView = getWorkspaceBrowserView(app.workspaceId, app.appKey);
  if (!browserView) throw new Error(`unknown workspace app: ${app.appKey}`);
  if (!browserView.targetUrl) throw new Error(`Browser view has no target URL: ${app.appKey}`);
  const target = browserRequestTarget(browserView, requestUrl);
  if (!isLoopbackHost(target.hostname)) throw new Error("External browser targets load directly and do not have a workspace proxy");

  const containerPort = Number(target.port || defaultPortForProtocol(target.protocol));
  if (!isWorkspacePreviewPort(containerPort)) {
    throw new Error(`Port ${target.port || defaultPortForProtocol(target.protocol)} is not published for browser previews. Use one of: ${workspacePreviewPorts.join(", ")}`);
  }

  return await workspacePreviewPortUrl(app.workspaceId, containerPort, target.pathname + target.search, target.protocol);
}

function defaultPortForProtocol(protocol: string): number {
  if (protocol === "https:") return 443;
  return 80;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized === "0.0.0.0";
}

function rewriteBrowserRedirect(app: WorkspaceAppHost, requestUrl: URL, requestTarget: URL, location: string, publicOrigin: string): string {
  let redirectTarget: URL;
  try {
    redirectTarget = new URL(location, requestTarget);
  } catch {
    return location;
  }
  if (redirectTarget.protocol !== "http:" && redirectTarget.protocol !== "https:") return location;

  setWorkspaceBrowserTarget(app.workspaceId, app.appKey, redirectTarget.toString());
  if (!isLoopbackHost(redirectTarget.hostname)) return redirectTarget.toString();
  return browserProxyUrl(redirectTarget, publicOrigin).toString();
}

function browserRequestTarget(view: WorkspaceBrowserView, requestUrl: URL): URL {
  const fallbackOrigin = new URL(view.targetUrl).origin;
  const targetOrigin = parseBrowserOrigin(requestUrl.searchParams.get(browserOriginParam)) ?? fallbackOrigin;
  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  stripBrowserProxyParams(target);
  return target;
}

function parseBrowserOrigin(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const origin = new URL(value);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") return undefined;
    return origin.origin;
  } catch {
    return undefined;
  }
}
