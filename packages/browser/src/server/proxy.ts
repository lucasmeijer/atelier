import { isWorkspacePreviewPort, workspacePreviewPortUrl, workspacePreviewPorts } from "@atelier/workspace";
import { publicWorkspaceAppOrigin, type WorkspaceAppHost } from "@atelier/proxy-ingress/server";
import { getWorkspaceBrowserView, setWorkspaceBrowserTarget, type WorkspaceBrowserView } from "./state.ts";
import { browserColorSchemeParam, browserOriginParam, browserProxyUrl, stripBrowserProxyParams } from "../shared.ts";

export function isBrowserWorkspaceApp(workspaceId: string, appKey: string): boolean {
  return Boolean(getWorkspaceBrowserView(workspaceId, appKey));
}

export async function patchBrowserWorkspaceAppRequestHeaders(_app: WorkspaceAppHost, headers: Headers, target: URL, _request: Request): Promise<Headers> {
  if (!isLoopbackHost(target.hostname)) headers.set("host", target.host);
  return headers;
}

export async function patchBrowserWorkspaceAppResponse(app: WorkspaceAppHost, response: Response, request: Request): Promise<Response> {
  const browserView = getWorkspaceBrowserView(app.workspaceId, app.appKey);
  if (!browserView) return response;
  const requestUrl = new URL(request.url);
  const requestTarget = browserRequestTarget(browserView, requestUrl);
  const publicOrigin = publicWorkspaceAppOrigin(request);
  const headers = new Headers(response.headers);
  const location = headers.get("location");
  if (location) headers.set("location", rewriteBrowserRedirect(app, requestUrl, requestTarget, location, publicOrigin));

  const isHtml = headers.get("content-type")?.toLowerCase().includes("text/html") ?? false;
  if (!isHtml) {
    return location ? new Response(response.body, { status: response.status, statusText: response.statusText, headers }) : response;
  }

  const text = await response.text();
  const rewritten = patchBrowserHtml(rewriteContainerLocalUrlsInHtml(text, publicOrigin), request, requestTarget.origin);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  return new Response(rewritten, { status: response.status, statusText: response.statusText, headers });
}

export async function resolveBrowserWorkspaceAppTarget(app: WorkspaceAppHost, requestUrl: URL): Promise<URL> {
  const browserView = getWorkspaceBrowserView(app.workspaceId, app.appKey);
  if (!browserView) throw new Error(`unknown workspace app: ${app.appKey}`);
  if (!browserView.targetUrl) throw new Error(`Browser view has no target URL: ${app.appKey}`);
  const target = browserRequestTarget(browserView, requestUrl);

  if (!isLoopbackHost(target.hostname)) return target;

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
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
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
  const proxyTarget = browserProxyUrl(redirectTarget, publicOrigin);
  const colorScheme = requestUrl.searchParams.get(browserColorSchemeParam);
  if (colorScheme) proxyTarget.searchParams.set(browserColorSchemeParam, colorScheme);
  return proxyTarget.toString();
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
  if (!isWorkspacePreviewPort(port)) return raw;
  return new URL(`${url.pathname}${url.search}${url.hash}`, publicOrigin).toString();
}

function patchBrowserHtml(html: string, request: Request, targetOrigin: string): string {
  return injectBrowserThemeStyle(injectBrowserBridgeScript(html, targetOrigin), request);
}

function injectBrowserBridgeScript(html: string, targetOrigin: string): string {
  if (html.includes("atelier:browser-location")) return html;
  return injectIntoHtml(html, `<script>${browserBridgeScript(targetOrigin)}</script>`);
}

function injectBrowserThemeStyle(html: string, request: Request): string {
  if (html.includes("data-atelier-browser-theme")) return html;
  const scheme = new URL(request.url).searchParams.get(browserColorSchemeParam) === "light" ? "light" : "dark";
  return injectIntoHtml(html, `<style data-atelier-browser-theme>html{color-scheme:${scheme};}</style>`);
}

function injectIntoHtml(html: string, addition: string): string {
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${addition}</head>`);
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${addition}</body>`);
  return `${html}${addition}`;
}

function browserBridgeScript(targetOrigin: string): string {
  return `(() => {
  if (window.__atelierBrowserBridgeInstalled) return;
  window.__atelierBrowserBridgeInstalled = true;
  const locationChanged = () => {
    parent.postMessage({ type: "atelier:browser-location", href: location.href, targetOrigin: ${JSON.stringify(targetOrigin)} }, "*");
  };
  const pushState = history.pushState;
  history.pushState = function(...args) {
    const result = pushState.apply(this, args);
    locationChanged();
    return result;
  };
  const replaceState = history.replaceState;
  history.replaceState = function(...args) {
    const result = replaceState.apply(this, args);
    locationChanged();
    return result;
  };
  addEventListener("popstate", locationChanged);
  addEventListener("hashchange", locationChanged);
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data || event.data.type !== "atelier:browser-command") return;
    if (event.data.command === "back") history.back();
    if (event.data.command === "forward") history.forward();
    if (event.data.command === "reload") location.reload();
  });
  locationChanged();
})();`;
}
