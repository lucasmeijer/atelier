import { escapeHtml } from "@atelier/shared";
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

  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  const plainTextError = response.status >= 400
    && contentType.startsWith("text/plain")
    && isDocumentRequest(request);
  const body = plainTextError ? renderPlainTextError(response.status, await response.text()) : response.body;
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

function renderPlainTextError(status: number, message: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Server rejecting this preview browser</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f3f5f9;
    --panel: #fff;
    --line: #e9edf3;
    --line-strong: #dde3ec;
    --text: #737e92;
    --text-bright: #1b2433;
    --accent: #2563eb;
    --danger: #d23b3b;
    --danger-soft: #fbeaea;
    --success: #138a52;
    font: 14px/1.5 -apple-system, "Inter", "Segoe UI", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  body { min-height: 100vh; margin: 0; padding: clamp(1rem, 5vw, 3rem); display: grid; place-items: center; background: var(--bg); color: var(--text); }
  main { width: min(100%, 46rem); overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
  header { min-height: 45px; display: flex; align-items: center; gap: 8px; padding-inline: 8px; border-bottom: 1px solid var(--line); }
  .mark { width: 28px; height: 28px; display: grid; flex: 0 0 auto; place-items: center; border-radius: 6px; background: var(--danger-soft); color: var(--danger); font-weight: 600; }
  h1 { flex: 1; margin: 0; color: var(--text-bright); font: inherit; font-weight: 600; }
  .status { color: var(--text); }
  .content { padding: 16px; }
  p { margin: 0 0 24px; }
  h2 { margin: 0 0 8px; color: var(--text-bright); font: inherit; font-weight: 600; }
  .copy-region { position: relative; }
  pre { max-height: 45vh; margin: 0; padding: 16px 48px 16px 16px; overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--bg); color: var(--text-bright); font: inherit; }
  .copy-button { position: absolute; z-index: 2; top: 6px; right: 6px; width: 26px; height: 26px; display: inline-grid; place-items: center; padding: 0; border: 1px solid color-mix(in srgb, var(--accent) 20%, var(--line)); border-radius: 999px; background: color-mix(in srgb, var(--panel) 72%, transparent); color: var(--text); font: inherit; cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 80ms ease; }
  .copy-button:hover, .copy-button:focus-visible { border-color: color-mix(in srgb, var(--accent) 65%, var(--text-bright)); outline: none; background: var(--panel); color: var(--text-bright); }
  .copy-button:active { transform: translateY(1px); }
  .copy-button[data-copied] { color: var(--success); }
  @media (prefers-color-scheme: dark) {
    :root { color-scheme: dark; --bg: #12171e; --panel: #181e26; --line: #2a333e; --line-strong: #394653; --text: #9aa7b5; --text-bright: #e6edf3; --accent: #58a6ff; --danger: #ff7b72; --danger-soft: #351d20; }
  }
</style>
<main>
  <header><span class="mark" aria-hidden="true">!</span><h1>Server rejecting this preview browser</h1><span class="status">HTTP ${status}</span></header>
  <div class="content">
    <p>The server you're trying to reach is rejecting your request, most likely because it didn't expect this embedded browser to come through the Atelier proxy. Give your agent this entire message, including the raw response from the server below, and it will know how to fix it.</p>
    <h2>Raw server response:</h2>
    <div class="copy-region">
      <button class="copy-button" id="copy-response" type="button" title="Copy raw server response" aria-label="Copy raw server response"><span aria-hidden="true">⧉</span></button>
      <pre id="raw-response">${escapeHtml(message)}</pre>
    </div>
  </div>
</main>
<script>
  const button = document.getElementById("copy-response");
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(document.getElementById("raw-response").textContent);
    button.dataset.copied = "";
    button.firstElementChild.textContent = "✓";
    button.title = "Copied to clipboard";
    button.setAttribute("aria-label", "Copied to clipboard");
    setTimeout(() => {
      delete button.dataset.copied;
      button.firstElementChild.textContent = "⧉";
      button.title = "Copy raw server response";
      button.setAttribute("aria-label", "Copy raw server response");
    }, 1500);
  });
</script>`;
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
