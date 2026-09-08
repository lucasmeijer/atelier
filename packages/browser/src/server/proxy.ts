import { inlineDesignSystemCss } from "@atelier/design-system/styles/server";
import { panelHtml } from "@atelier/design-system/panel";
import { escapeHtml, type WorkspaceHttpAppBackend } from "@atelier/shared";
import { workspacePortBackend } from "@atelier/workspace";
import { nestedWorkspaceProxyRedirectHeader, publicWorkspaceAppOrigin, type WorkspaceAppHost } from "@atelier/proxy-ingress/server";
import { getWorkspaceBrowserView, setWorkspaceBrowserTarget } from "./state.ts";
import { browserProxyUrl, browserRequestTarget, isWorkspaceLoopbackHost } from "../shared.ts";

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

  const location = headers.get("location");
  if (location) {
    const requestTarget = browserRequestTarget(browserView, new URL(request.url));
    headers.set("location", rewriteBrowserRedirect(app, requestTarget, location, publicWorkspaceAppOrigin(request)));
  }

  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  const plainTextError = response.status >= 400
    && contentType.startsWith("text/plain")
    && isDocumentRequest(request);
  const body = plainTextError ? await renderPlainTextError(response.status, await response.text()) : response.body;
  if (plainTextError) {
    headers.set("content-type", "text/html; charset=utf-8");
    headers.delete("content-length");
  }

  const isHtml = plainTextError || contentType.includes("text/html");
  if (!isHtml) {
    return location ? new Response(body, { status: response.status, statusText: response.statusText, headers }) : response;
  }

  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function isDocumentRequest(request: Request): boolean {
  const destination = request.headers.get("sec-fetch-dest")?.toLowerCase();
  return destination === "iframe" || destination === "document";
}

async function renderPlainTextError(status: number, message: string): Promise<string> {
  const panel = panelHtml({
    element: { tag: "section" },
    headerHtml: `<h1 class="panel__title">Server rejecting this preview browser</h1><span>HTTP ${status}</span>`,
    bodyHtml: `<div class="error-content"><p>The server you're trying to reach is rejecting your request, most likely because it didn't expect this embedded browser to come through the Atelier proxy. Give your agent this entire message, including the raw response below.</p><h2 class="title">Raw server response</h2><p>Select and copy this response:</p><pre>${escapeHtml(message)}</pre></div>`,
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Server rejecting this preview browser</title><style>${await inlineDesignSystemCss()}
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; padding: 24px; display: grid; place-items: center; background: var(--bg); color: var(--text); font: var(--text-body)/var(--leading-standard) var(--font-sans); }
    main { width: min(100%, 46rem); min-width: 0; }
    .error-content { padding: 16px; }
    pre { max-height: 45vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: var(--text-code)/var(--leading-standard) var(--font-mono); color: var(--text-bright); }
  </style></head><body><main>${panel}</main></body></html>`;
}

export async function resolveBrowserWorkspaceAppBackend(app: WorkspaceAppHost, requestUrl: URL): Promise<WorkspaceHttpAppBackend> {
  const browserView = getWorkspaceBrowserView(app.workspaceId, app.appKey);
  if (!browserView) throw new Error(`unknown workspace app: ${app.appKey}`);
  if (!browserView.targetUrl) throw new Error(`Browser view has no target URL: ${app.appKey}`);
  const target = browserRequestTarget(browserView, requestUrl);
  if (!isWorkspaceLoopbackHost(target.hostname)) throw new Error("External browser targets load directly and do not have a workspace proxy");

  const containerPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  return await workspacePortBackend(app.workspaceId, containerPort, target.pathname + target.search, target.protocol);
}

function rewriteBrowserRedirect(app: WorkspaceAppHost, requestTarget: URL, location: string, publicOrigin: string): string {
  let redirectTarget: URL;
  try {
    redirectTarget = new URL(location, requestTarget);
  } catch {
    return location;
  }
  if (redirectTarget.protocol !== "http:" && redirectTarget.protocol !== "https:") return location;

  setWorkspaceBrowserTarget(app.workspaceId, app.appKey, redirectTarget.toString());
  if (!isWorkspaceLoopbackHost(redirectTarget.hostname)) return redirectTarget.toString();
  return browserProxyUrl(app.appKey, redirectTarget, publicOrigin).toString();
}
