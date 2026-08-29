import { isWorkspacePreviewPort, workspacePreviewPortUrl, workspacePreviewPorts } from "@atelier/workspace";
import { nestedWorkspaceProxyRedirectHeader, publicWorkspaceAppOrigin, type WorkspaceAppHost } from "@atelier/proxy-ingress/server";
import { getWorkspaceBrowserView, setWorkspaceBrowserTarget, type WorkspaceBrowserView } from "./state.ts";
import { browserColorSchemeParam, browserOriginParam, browserProxyUrl, stripBrowserProxyParams } from "../shared.ts";

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
  if (request.headers.has("turbo-frame")) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  const additions = `${browserBridgeElement(requestTarget.origin)}${browserThemeElement(request)}`;
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(injectIntoHtmlStream(response.body!, additions), { status: response.status, statusText: response.statusText, headers });
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

function browserBridgeElement(targetOrigin: string): string {
  return `<script>${browserBridgeScript(targetOrigin)}</script>`;
}

function browserThemeElement(request: Request): string {
  const scheme = new URL(request.url).searchParams.get(browserColorSchemeParam) === "light" ? "light" : "dark";
  return `<style data-atelier-browser-theme>html{color-scheme:${scheme};}</style>`;
}

function injectIntoHtmlStream(body: ReadableStream<Uint8Array>, addition: string): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let prefix = "";
  let injected = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (!injected) controller.enqueue(encoder.encode(`${prefix}${addition}`));
        else {
          const tail = decoder.decode();
          if (tail) controller.enqueue(encoder.encode(tail));
        }
        controller.close();
        return;
      }
      if (injected) {
        const text = decoder.decode(chunk.value, { stream: true });
        if (text) controller.enqueue(encoder.encode(text));
        return;
      }
      prefix += decoder.decode(chunk.value, { stream: true });
      const match = /<\/head\s*>/i.exec(prefix) ?? /<\/body\s*>/i.exec(prefix);
      if (!match && prefix.length < 64 * 1024) return;
      const offset = match?.index ?? prefix.length;
      controller.enqueue(encoder.encode(`${prefix.slice(0, offset)}${addition}${prefix.slice(offset)}`));
      prefix = "";
      injected = true;
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function browserBridgeScript(targetOrigin: string): string {
  return `(() => {
  if (window.__atelierBrowserBridgeInstalled) return;
  window.__atelierBrowserBridgeInstalled = true;
  const locationChanged = () => {
    parent.postMessage({ type: "atelier:browser-location", href: location.href, targetOrigin: ${JSON.stringify(targetOrigin)} }, "*");
  };
  const localPreviewUrl = (raw) => {
    let target;
    try { target = new URL(raw, ${JSON.stringify(targetOrigin)}); } catch { return undefined; }
    const host = target.hostname.toLowerCase();
    if (!["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(host)) return undefined;
    const proxy = new URL(target.pathname + target.search + target.hash, location.origin);
    proxy.searchParams.set("atelierBrowserOrigin", target.origin);
    const scheme = new URL(location.href).searchParams.get("atelierColorScheme");
    if (scheme) proxy.searchParams.set("atelierColorScheme", scheme);
    return proxy;
  };
  addEventListener("click", (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    const proxy = localPreviewUrl(anchor.href);
    if (!proxy) return;
    if (anchor.target && anchor.target !== "_self") {
      anchor.href = proxy.toString();
      return;
    }
    event.preventDefault();
    location.assign(proxy);
  });
  addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const proxy = localPreviewUrl(form.action);
    if (proxy) form.action = proxy.toString();
  }, true);
  const open = window.open;
  window.open = function(raw, target, features) {
    const proxy = typeof raw === "string" || raw instanceof URL ? localPreviewUrl(raw) : undefined;
    return open.call(window, proxy?.toString() ?? raw, target, features);
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
