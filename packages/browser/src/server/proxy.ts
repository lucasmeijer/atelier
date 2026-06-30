import { workspacePreviewPortUrl, workspacePreviewPorts } from "@atelier/workspace";
import { publicWorkspaceAppOrigin, type WorkspaceAppHost } from "@atelier/proxy-ingress/server";
import { getWorkspaceBrowserTab } from "./state.ts";

export function isBrowserWorkspaceApp(workspaceId: string, appKey: string): boolean {
  return Boolean(getWorkspaceBrowserTab(workspaceId, appKey));
}

export async function patchBrowserWorkspaceAppRequestHeaders(app: WorkspaceAppHost, headers: Headers, _target: URL, _request: Request): Promise<Headers> {
  if (!isBrowserWorkspaceApp(app.workspaceId, app.appKey)) return headers;
  const browserTab = getWorkspaceBrowserTab(app.workspaceId, app.appKey);
  if (!browserTab) throw new Error(`unknown workspace app: ${app.appKey}`);
  const targetBase = new URL(browserTab.targetUrl);
  if (!isLoopbackHost(targetBase.hostname)) headers.set("host", targetBase.host);
  return headers;
}

export async function patchBrowserWorkspaceAppResponse(app: WorkspaceAppHost, response: Response, request: Request): Promise<Response> {
  if (!isBrowserWorkspaceApp(app.workspaceId, app.appKey)) return response;

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
  const rewritten = injectBrowserBridgeScript(rewriteContainerLocalUrlsInHtml(text, publicOrigin));
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  return new Response(rewritten, { status: response.status, statusText: response.statusText, headers });
}

export async function resolveBrowserWorkspaceAppTarget(app: WorkspaceAppHost, requestUrl: URL): Promise<URL> {
  const browserTab = getWorkspaceBrowserTab(app.workspaceId, app.appKey);
  if (!browserTab) throw new Error(`unknown workspace app: ${app.appKey}`);
  if (!browserTab.targetUrl) throw new Error(`browser tab has no target url: ${app.appKey}`);
  const targetBase = new URL(browserTab.targetUrl);
  const target = new URL(requestUrl.pathname + requestUrl.search, targetBase);

  if (!isLoopbackHost(target.hostname)) return target;

  const containerPort = Number(target.port || defaultPortForProtocol(target.protocol));
  if (!Number.isInteger(containerPort) || !(workspacePreviewPorts as readonly number[]).includes(containerPort)) {
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

function injectBrowserBridgeScript(html: string): string {
  if (html.includes("atelier:browser-location")) return html;
  const script = `<script>${browserBridgeScript()}</script>`;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${script}</head>`);
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${script}</body>`);
  return `${html}${script}`;
}

function browserBridgeScript(): string {
  return `(() => {
  if (window.__atelierBrowserBridgeInstalled) return;
  window.__atelierBrowserBridgeInstalled = true;
  const locationChanged = () => {
    parent.postMessage({ type: "atelier:browser-location", href: location.href }, "*");
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
