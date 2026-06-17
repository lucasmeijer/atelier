import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  closeAgentTermSocket,
  ensureDefaultWorkspaceAgent,
  handleAgentTermSocketMessage,
  openAgentTermSocket,
  registerAgentEvents,
  resolveWorkspacePortProxyTarget,
  workspaceFileEndpoint,
  subscribeWorkspaceTabBusy,
  validateAgentTermSocket,
  type AgentTermSocketData,
} from "@atelier/agent/server";
import { isBrowserWorkspaceApp, patchBrowserWorkspaceAppResponse, resolveBrowserWorkspaceAppTarget } from "@atelier/browser/server";
import { createAtelierEventBus, defaultDataDir } from "@atelier/core";
import { desktopAppKey, resolveDesktopWorkspaceAppTarget } from "@atelier/desktop/server";
import { inspectWorkspaceDeleteSafety, registerRepositoryWorkspaceEvents } from "@atelier/repository";
import { createWorkspace, deleteWorkspace, listWorkspaces } from "@atelier/workspace";
import { ensureAtelierWorkspaceProxy, registerWorkspaceProxyEvents } from "@atelier/workspace-proxy";
import { registerPiConfigEvents } from "@atelier/pi-config/server";
import {
  closeTerminalSocket,
  handleTerminalSocketMessage,
  openTerminalSocket,
  registerTerminalEvents,
  subscribeTerminalTabBusy,
  validateTerminalSocket,
  type TerminalSocketData,
} from "@atelier/workspace-terminal/server";
import { atelierName } from "@atelier/shared";
import {
  parseWorkspaceAppHost,
  proxyWorkspaceAppRequest,
  workspaceAppWebSocketTarget,
  type WorkspaceAppHost,
  type WorkspaceAppResponseTransformer,
  type WorkspaceAppTargetResolver,
} from "@atelier/workspace-proxy/server";
import { patchVSCodeWorkspaceAppResponse, registerVSCodeEvents, resolveVSCodeWorkspaceAppTarget, vscodeAppKey } from "@atelier/vscode/server";
import { createWebApp } from "./app.ts";
import { createFileWebPreferenceStore } from "./preferences.ts";
import { createStreamHub } from "./stream-hub.ts";
import { legacyStaticFiles } from "./static-files.ts";
import { createWorkspaceLayoutStore } from "./workspace-layout.ts";
import { createFileWorkspaceActivityStore, createWorkspaceRegistry } from "./workspace-registry.ts";

const requestedPort = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "localhost";

const authPassword = process.env.ATELIER_PASSWORD ?? "";
const authCookieName = "atelier_session";
const authCookieMaxAgeSeconds = 60 * 60 * 24 * 30;

function authSecret(): string {
  return process.env.ATELIER_AUTH_SECRET || authPassword;
}

function authEnabled(): boolean {
  return authPassword.length > 0;
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmac(input: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return rawValue.join("=");
  }
  return undefined;
}

async function createAuthSessionCookie(): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + authCookieMaxAgeSeconds;
  const nonce = crypto.randomUUID();
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ expires, nonce })));
  return `${payload}.${await hmac(payload)}`;
}

async function isAuthenticated(request: Request): Promise<boolean> {
  if (!authEnabled()) return true;
  const value = cookieValue(request, authCookieName);
  if (!value) return false;
  const [payload, signature] = value.split(".");
  if (!payload || !signature || !timingSafeEqual(signature, await hmac(payload))) return false;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)))) as { expires?: number };
    return typeof data.expires === "number" && data.expires > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function isHttpsRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

function authCookieAttributes(request: Request): string {
  const secure = isHttpsRequest(request) ? "; Secure" : "";
  const domain = process.env.ATELIER_AUTH_COOKIE_DOMAIN ? `; Domain=${process.env.ATELIER_AUTH_COOKIE_DOMAIN}` : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${authCookieMaxAgeSeconds}${secure}${domain}`;
}

function clearAuthCookieAttributes(request: Request): string {
  const secure = isHttpsRequest(request) ? "; Secure" : "";
  const domain = process.env.ATELIER_AUTH_COOKIE_DOMAIN ? `; Domain=${process.env.ATELIER_AUTH_COOKIE_DOMAIN}` : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}${domain}`;
}

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function loginPage(next: string, error = ""): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(atelierName)} · Login</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f8fc; color: #172033; }
  form { width: min(360px, calc(100vw - 32px)); display: grid; gap: 14px; padding: 24px; border: 1px solid #d8e0ec; border-radius: 16px; background: white; box-shadow: 0 18px 50px rgba(15, 23, 42, .08); }
  h1 { margin: 0; font-size: 18px; }
  input, button { font: inherit; border-radius: 10px; padding: 10px 12px; }
  input { border: 1px solid #cbd5e1; }
  button { border: 0; background: #2563eb; color: white; font-weight: 650; cursor: pointer; }
  .error { color: #b42318; min-height: 20px; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Sign in to ${escapeHtml(atelierName)}</h1>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : `<div class="error"></div>`}
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <input name="password" type="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
</form>
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirectToLogin(request: Request): Response {
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}`;
  return Response.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, url).toString(), 303);
}

async function authResponse(request: Request): Promise<Response | undefined> {
  if (!authEnabled()) return undefined;
  const url = new URL(request.url);
  if (url.pathname === "/up") return undefined;
  if (url.pathname === "/login" && request.method === "GET") return loginPage(url.searchParams.get("next") || "/");
  if (url.pathname === "/login" && request.method === "POST") {
    const form = await request.formData();
    const next = String(form.get("next") || "/");
    const password = String(form.get("password") || "");
    if (!timingSafeEqual(password, authPassword)) return loginPage(next, "Invalid password");
    const response = Response.redirect(new URL(next.startsWith("/") ? next : "/", url).toString(), 303);
    response.headers.append("set-cookie", `${authCookieName}=${await createAuthSessionCookie()}; ${authCookieAttributes(request)}`);
    return response;
  }
  if (url.pathname === "/logout") {
    const response = Response.redirect(new URL("/login", url).toString(), 303);
    response.headers.append("set-cookie", `${authCookieName}=; ${clearAuthCookieAttributes(request)}`);
    return response;
  }
  if (await isAuthenticated(request)) return undefined;
  const accepts = request.headers.get("accept") ?? "";
  if (request.method === "GET" && accepts.includes("text/html")) return redirectToLogin(request);
  return new Response("unauthorized\n", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
}

const atelierEvents = createAtelierEventBus();
registerRepositoryWorkspaceEvents(atelierEvents);
registerWorkspaceProxyEvents(atelierEvents);
registerPiConfigEvents(atelierEvents);
registerTerminalEvents(atelierEvents);
registerVSCodeEvents(atelierEvents);
registerAgentEvents(atelierEvents);

const registry = createWorkspaceRegistry({
  activityStore: createFileWorkspaceActivityStore(join(defaultDataDir(), "view-state", "workspace-activity.json")),
});
const hub = createStreamHub();
const layouts = createWorkspaceLayoutStore();

function stringFromContext(context: unknown, key: string): string | undefined {
  if (!context || typeof context !== "object" || !(key in context)) return undefined;
  const value = (context as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sourceRepositoryFromContext(context: unknown): { sourceRepositoryId?: string; sourceRepositoryName?: string } {
  return {
    sourceRepositoryId: stringFromContext(context, "sourceRepositoryId"),
    sourceRepositoryName: stringFromContext(context, "sourceRepositoryName"),
  };
}

const app = createWebApp({
  registry,
  hub,
  layouts,
  events: atelierEvents,
  preferences: createFileWebPreferenceStore(join(defaultDataDir(), "view-state", "preferences.json")),
  async provisionWorkspace(id, options) {
    await createWorkspace({ id, events: atelierEvents, ...sourceRepositoryFromContext(options?.context), context: options?.context });
    await ensureDefaultWorkspaceAgent(id);
    await atelierEvents.emit("workspace_created", { workspaceId: id, context: options?.context });
  },
  inspectDeleteSafety: (id) => inspectWorkspaceDeleteSafety(id),
  destroyWorkspace: async (id) => {
    await deleteWorkspace(id, { force: true, events: atelierEvents });
  },
});

atelierEvents.on("workspace_user_activity", ({ workspaceId }) => registry.touch(workspaceId));
atelierEvents.on("workspace_title_changed", ({ workspaceId, title }) => registry.setTitle(workspaceId, title || null));
subscribeWorkspaceTabBusy(({ workspaceId, tabKey, busy }) => registry.setTabBusy(workspaceId, tabKey, busy));
subscribeTerminalTabBusy(({ workspaceId, tabKey, busy }) => registry.setTabBusy(workspaceId, tabKey, busy));

// Docker is the persistent truth for which workspaces exist; seed the registry from it.
await registry.seed((await listWorkspaces()).workspaces);

function contentTypeForStaticPath(pathname: string): string {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

async function serveStatic(pathname: string): Promise<Response | undefined> {
  if (pathname.startsWith("/assets/")) {
    const file = Bun.file(new URL(`../../public${pathname}`, import.meta.url));
    if (!(await file.exists())) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(file, {
      headers: {
        "content-type": contentTypeForStaticPath(pathname),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  const entry = legacyStaticFiles[pathname];
  if (!entry) return undefined;
  const file = Bun.file(entry.url);
  if (!(await file.exists())) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  const headers: Record<string, string> = { "content-type": entry.contentType };
  if (pathname === "/workspace.js") headers["cache-control"] = "no-store";
  return new Response(file, { headers });
}

interface WorkspaceAppProxySocketData {
  kind: "workspace-app-proxy";
  target: string;
  host: string;
  protocols: string[];
}

type SocketData = TerminalSocketData | AgentTermSocketData | WorkspaceAppProxySocketData;

const workspacePortAppKeyPattern = /^port-(\d+)$/;

const resolveWorkspaceAppTarget: WorkspaceAppTargetResolver = async (app, requestUrl) => {
  if (app.appKey === vscodeAppKey) return await resolveVSCodeWorkspaceAppTarget(app, requestUrl);
  if (app.appKey === desktopAppKey) return await resolveDesktopWorkspaceAppTarget(app, requestUrl);
  if (isBrowserWorkspaceApp(app.appKey)) return await resolveBrowserWorkspaceAppTarget(app, requestUrl);
  const portMatch = app.appKey.match(workspacePortAppKeyPattern);
  if (portMatch) return await resolveWorkspacePortProxyTarget(app.workspaceId, Number(portMatch[1]), requestUrl.pathname, requestUrl.search);
  throw new Error(`unknown workspace app: ${app.appKey}`);
};

const patchWorkspaceAppResponse: WorkspaceAppResponseTransformer = async (app, response, request) => {
  if (isBrowserWorkspaceApp(app.appKey)) return await patchBrowserWorkspaceAppResponse(app, response, request);
  if (app.appKey === vscodeAppKey) return await patchVSCodeWorkspaceAppResponse(app, response);
  return response;
};

async function validateSocket(request: Request, url: URL): Promise<SocketData | undefined> {
  const appHost = parseWorkspaceAppHost(request.headers.get("host"));
  if (appHost) {
    if (appHost.appKey === "file") return undefined;
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((protocol) => protocol.trim()).filter(Boolean);
    return { kind: "workspace-app-proxy", target: await workspaceAppWebSocketTarget(appHost, url.pathname, url.search, resolveWorkspaceAppTarget), host: request.headers.get("host") ?? url.host, protocols };
  }
  return validateAgentTermSocket(url) ?? (await validateTerminalSocket(url));
}

function openWorkspaceAppProxySocket(ws: ServerWebSocket<WorkspaceAppProxySocketData>): void {
  const WebSocketWithOptions = WebSocket as unknown as new (url: string, options: { headers?: Record<string, string>; protocols?: string[] }) => WebSocket;
  const upstream = new WebSocketWithOptions(ws.data.target, { headers: { Host: ws.data.host }, protocols: ws.data.protocols });
  upstream.binaryType = "arraybuffer";
  const pending: Array<string | ArrayBuffer> = [];
  (ws.data as WorkspaceAppProxySocketData & { upstream?: WebSocket; pending?: Array<string | ArrayBuffer> }).upstream = upstream;
  (ws.data as WorkspaceAppProxySocketData & { pending?: Array<string | ArrayBuffer> }).pending = pending;
  upstream.addEventListener("open", () => {
    for (const message of pending.splice(0)) upstream.send(message);
  });
  upstream.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      ws.send(event.data);
    } else if (event.data instanceof ArrayBuffer) {
      ws.send(event.data);
    } else if (event.data instanceof Blob) {
      void event.data.arrayBuffer().then((buffer) => ws.send(buffer)).catch(() => ws.close());
    }
  });
  upstream.addEventListener("close", () => ws.close());
  upstream.addEventListener("error", () => ws.close());
}

function handleWorkspaceAppProxySocketMessage(ws: ServerWebSocket<WorkspaceAppProxySocketData>, message: string | Buffer): void {
  const data = ws.data as WorkspaceAppProxySocketData & { upstream?: WebSocket; pending?: Array<string | ArrayBuffer> };
  const payload = typeof message === "string" ? message : new Uint8Array(message).slice().buffer;
  if (data.upstream?.readyState === WebSocket.OPEN) data.upstream.send(payload);
  else data.pending?.push(payload);
}

function closeWorkspaceAppProxySocket(ws: ServerWebSocket<WorkspaceAppProxySocketData>): void {
  const upstream = (ws.data as WorkspaceAppProxySocketData & { upstream?: WebSocket }).upstream;
  if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close();
}

await ensureAtelierWorkspaceProxy();

const maxPortAttempts = 100;
let serverPort = 0;

for (let attempt = 0; attempt < maxPortAttempts; attempt++) {
  const port = requestedPort === 0 ? 0 : requestedPort + attempt;

  try {
    const server = Bun.serve<SocketData>({
      hostname,
      port,
      // The app intentionally uses long-lived SSE endpoints (workspace status,
      // agent transcript streams). Bun's default 10s idle
      // timeout kills quiet EventSource requests and logs
      // "request timed out after 10 seconds". Keep SSE alive with heartbeats,
      // and give stalled samples enough headroom before Bun closes the request.
      idleTimeout: 255,
      async fetch(request, server) {
        const url = new URL(request.url);
        const appHost = parseWorkspaceAppHost(request.headers.get("host"));
        const auth = await authResponse(request);
        if (auth) return auth;

        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const socketData = await validateSocket(request, url);
          if (!socketData) return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
          if (server.upgrade(request, { data: socketData })) return undefined;
          return new Response("websocket upgrade failed", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
        }

        if (appHost?.appKey === "file") return await workspaceFileEndpoint(appHost.workspaceId, decodeURIComponent(url.pathname), request);
        if (appHost) return await proxyWorkspaceAppRequest(appHost, request, resolveWorkspaceAppTarget, patchWorkspaceAppResponse);

        const staticResponse = await serveStatic(url.pathname);
        if (staticResponse) return staticResponse;

        return await app.fetch(request);
      },
      websocket: {
        open(ws) {
          if (ws.data.kind === "terminal") openTerminalSocket(ws as ServerWebSocket<TerminalSocketData>);
          if (ws.data.kind === "agent-term") openAgentTermSocket(ws as ServerWebSocket<AgentTermSocketData>);
          if (ws.data.kind === "workspace-app-proxy") openWorkspaceAppProxySocket(ws as ServerWebSocket<WorkspaceAppProxySocketData>);
        },
        message(ws, message) {
          if (ws.data.kind === "terminal") handleTerminalSocketMessage(ws as ServerWebSocket<TerminalSocketData>, message);
          if (ws.data.kind === "agent-term") handleAgentTermSocketMessage(ws as ServerWebSocket<AgentTermSocketData>, message);
          if (ws.data.kind === "workspace-app-proxy") handleWorkspaceAppProxySocketMessage(ws as ServerWebSocket<WorkspaceAppProxySocketData>, message as string | Buffer);
        },
        close(ws) {
          if (ws.data.kind === "terminal") closeTerminalSocket(ws as ServerWebSocket<TerminalSocketData>);
          if (ws.data.kind === "agent-term") closeAgentTermSocket(ws as ServerWebSocket<AgentTermSocketData>);
          if (ws.data.kind === "workspace-app-proxy") closeWorkspaceAppProxySocket(ws as ServerWebSocket<WorkspaceAppProxySocketData>);
        },
      },
    });
    serverPort = server.port ?? port;
    break;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "EADDRINUSE" || requestedPort === 0) throw error;
  }
}

if (serverPort === 0) throw new Error(`No available port found from ${requestedPort} through ${requestedPort + maxPortAttempts - 1}`);

console.log(`${atelierName} web listening on http://${hostname}:${serverPort}`);
