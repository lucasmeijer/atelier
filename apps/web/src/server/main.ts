import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { createAtelierEventBus, defaultDataDir } from "@atelier/core";
import { attachHostObservableTerminal, observableTerminalCols, observableTerminalRows, type IPty } from "@atelier/observable-terminal/server";
import { createWorkspace, deleteWorkspace, listWorkspaces, resolveWorkspace } from "@atelier/workspace";
import type { WorkspaceDeleteSafetyIssue } from "@atelier/repository";
import { atelierName, type WorkspaceServerAppHandler, type WorkspaceServerProvisioningHook, type WorkspaceServerSocketHandler } from "@atelier/shared";
import {
  createWorkspaceIngressProxy,
  releaseWorkspacePublicProxyRoutes,
  type WorkspaceAppHost,
  type WorkspaceAppResponseTransformer,
  type WorkspaceAppTargetResolver,
} from "@atelier/proxy-ingress/server";
import { createWebApp } from "./app.ts";
import { createFileWebPreferenceStore } from "./preferences.ts";
import { createStreamHub } from "./stream-hub.ts";
import { legacyStaticFiles } from "./static-files.ts";
import { createWorkspaceLayoutStore } from "./workspace-layout.ts";
import { createFileWorkspaceActivityStore, createWorkspaceRegistry } from "./workspace-registry.ts";
import { workspaceModules } from "./workspace-modules.ts";

const requestedPort = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";
const allowPortFallback = process.env.ATELIER_PORT_FALLBACK === "1";

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

function sharedCookieDomain(request: Request): string | undefined {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || /^[\d.]+$/.test(hostname) || hostname.includes(":")) return undefined;
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length < 2) return undefined;
  return `.${labels.slice(-2).join(".")}`;
}

function authCookieAttributes(request: Request): string {
  const secure = isHttpsRequest(request) ? "; Secure" : "";
  const cookieDomain = sharedCookieDomain(request);
  const domain = cookieDomain ? `; Domain=${cookieDomain}` : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${authCookieMaxAgeSeconds}${secure}${domain}`;
}

function clearAuthCookieAttributes(request: Request): string {
  const secure = isHttpsRequest(request) ? "; Secure" : "";
  const cookieDomain = sharedCookieDomain(request);
  const domain = cookieDomain ? `; Domain=${cookieDomain}` : "";
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
const socketHandlers: WorkspaceServerSocketHandler[] = [];
const workspaceAppHandlers: WorkspaceServerAppHandler[] = [];
const provisioningHooks: WorkspaceServerProvisioningHook[] = [];
const workspaceRemovedHandlers: Array<(workspaceId: string) => void | Promise<void>> = [];

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
  provisioningHooks,
  workspaceRemovedHandlers,
  async provisionWorkspace(id, options) {
    await createWorkspace({ id, events: atelierEvents, ...sourceRepositoryFromContext(options?.context), context: options?.context });
    for (const hook of provisioningHooks) {
      await atelierEvents.emit("workspace_provision_step", { workspaceId: id, id: hook.id, label: hook.label, parentId: hook.parentId, status: "running" });
      try {
        await hook.run({ workspaceId: id, creationContext: options?.context, events: atelierEvents });
        await atelierEvents.emit("workspace_provision_step", { workspaceId: id, id: hook.id, label: hook.label, parentId: hook.parentId, status: "done" });
      } catch (error) {
        await atelierEvents.emit("workspace_provision_step", { workspaceId: id, id: hook.id, label: hook.label, parentId: hook.parentId, status: "failed", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
    await atelierEvents.emit("workspace_provision_step", { workspaceId: id, id: "workspace.integrations", label: "Run workspace startup integrations", status: "running" });
    await atelierEvents.emit("workspace_created", { workspaceId: id, context: options?.context });
    await atelierEvents.emit("workspace_provision_step", { workspaceId: id, id: "workspace.integrations", label: "Run workspace startup integrations", status: "done" });
  },
  inspectDeleteSafety: async (id) => {
    const issues: WorkspaceDeleteSafetyIssue[] = [];
    await atelierEvents.emit("workspace_delete_inspect", { workspaceId: id, issues });
    return { workspaceId: id, issues };
  },
  destroyWorkspace: async (id) => {
    publicWorkspaceAppProxy.stopWorkspace(id);
    await releaseWorkspacePublicProxyRoutes(id);
    await deleteWorkspace(id, { force: true, events: atelierEvents });
  },
});

atelierEvents.on("workspace_user_activity", ({ workspaceId }) => registry.touch(workspaceId));
atelierEvents.on("workspace_title_changed", ({ workspaceId, title }) => registry.setTitle(workspaceId, title || null));
atelierEvents.on("workspace_tab_unread", ({ workspaceId, tabKey, unread }) => registry.setTabUnread(workspaceId, tabKey, unread));
for (const module of workspaceModules) {
  await module.initialize?.({
    events: atelierEvents,
    registry,
    workspaceRowContributions: app.workspaceRowContributions,
    layouts,
    getTabKeys: (workspaceId) => app.tabKeysFor(workspaceId),
    deleteCurrentWorkspace: (workspaceId, force) => app.deleteCurrentWorkspaceFromAgent(workspaceId, force),
    registerSocketHandler: (handler) => socketHandlers.push(handler),
    registerWorkspaceAppHandler: (handler) => workspaceAppHandlers.push(handler),
    registerProvisioningHook: (hook) => provisioningHooks.push(hook),
    onWorkspaceRemoved: (handler) => workspaceRemovedHandlers.push(handler),
  });
}

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

interface ProvisionTermSocketData {
  kind: "provision-term";
  session: string;
  pty?: IPty;
}

type SocketData = ({ kind: string } & Record<string, unknown>) | ProvisionTermSocketData;
const socketHandlersByKind = new Map<string, WorkspaceServerSocketHandler>();

const resolveWorkspaceAppTarget: WorkspaceAppTargetResolver = async (app, requestUrl) => {
  for (const handler of workspaceAppHandlers) {
    if (!handler.matches(app) || !handler.resolveTarget) continue;
    const target = await handler.resolveTarget(app, requestUrl);
    if (target) return target;
  }
  throw new Error(`unknown workspace app: ${app.appKey}`);
};

const patchWorkspaceAppResponse: WorkspaceAppResponseTransformer = async (app, response, request) => {
  let next = response;
  for (const handler of workspaceAppHandlers) {
    if (handler.matches(app) && handler.transformResponse) next = await handler.transformResponse(app, next, request);
  }
  return next;
};

const publicWorkspaceAppProxy = createWorkspaceIngressProxy({
  hostname,
  authResponse,
  resolveWorkspace,
  listWorkspaceIds: async () => (await listWorkspaces()).workspaces.map((workspace) => workspace.id),
  resolveTarget: resolveWorkspaceAppTarget,
  transformResponse: patchWorkspaceAppResponse,
});

async function handleWorkspaceAppRequest(app: WorkspaceAppHost, request: Request, url: URL): Promise<Response | undefined> {
  for (const handler of workspaceAppHandlers) {
    if (!handler.matches(app) || !handler.handleRequest) continue;
    const response = await handler.handleRequest(app, request, url);
    if (response) return response;
  }
  return undefined;
}

async function handleCanonicalProxyRequest(url: URL, request: Request): Promise<Response | undefined> {
  const appMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/apps\/([^/]+)(\/.*)?$/);
  if (appMatch) {
    const workspaceId = decodeURIComponent(appMatch[1] ?? "");
    const appKey = decodeURIComponent(appMatch[2] ?? "");
    const path = `${appMatch[3] || "/"}${url.search}`;
    return await publicWorkspaceAppProxy.redirectToRoute(workspaceId, appKey, path, request);
  }

  const portMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/ports\/(\d+)(\/.*)?$/);
  if (portMatch) {
    const workspaceId = decodeURIComponent(portMatch[1] ?? "");
    const port = Number(portMatch[2]);
    const path = `${portMatch[3] || "/"}${url.search}`;
    return await publicWorkspaceAppProxy.redirectToRoute(workspaceId, `port-${port}`, path, request);
  }

  const fileMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/files(\/.*)$/);
  if (fileMatch) {
    const workspaceId = decodeURIComponent(fileMatch[1] ?? "");
    const path = decodeURIComponent(fileMatch[2] ?? "/");
    const fileUrl = new URL(request.url);
    fileUrl.pathname = path;
    return await handleWorkspaceAppRequest({ workspaceId, appKey: "file" }, request, fileUrl);
  }

  return undefined;
}

async function validateSocket(request: Request, url: URL): Promise<SocketData | undefined> {
  const provisionMatch = url.pathname.match(/^\/provision-term\/([^/]+)\/ws$/);
  if (provisionMatch) {
    const session = decodeURIComponent(provisionMatch[1]);
    if (!session.startsWith("atelier-provision-")) return undefined;
    return { kind: "provision-term", session };
  }
  for (const handler of socketHandlers) {
    const data = await handler.validate?.(request, url);
    if (!data || typeof data !== "object" || typeof (data as { kind?: unknown }).kind !== "string") continue;
    socketHandlersByKind.set((data as { kind: string }).kind, handler);
    return data as SocketData;
  }
  return undefined;
}

function openProvisionTermSocket(ws: ServerWebSocket<ProvisionTermSocketData>): void {
  void (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const pty = attachHostObservableTerminal({ session: ws.data.session, cols: observableTerminalCols, rows: observableTerminalRows, readonly: true, fixedSize: true });
        ws.data.pty = pty;
        pty.onData((chunk) => {
          try { ws.send(chunk); } catch { /* closed */ }
        });
        pty.onExit(() => ws.close());
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    try { ws.send(`\r\n[provision terminal attach failed: ${lastError instanceof Error ? lastError.message : String(lastError)}]\r\n`); } catch { /* closed */ }
    ws.close();
  })();
}

function closeProvisionTermSocket(ws: ServerWebSocket<ProvisionTermSocketData>): void {
  ws.data.pty?.kill();
}

await publicWorkspaceAppProxy.startPersistedRoutes();
const maxPortAttempts = allowPortFallback ? 100 : 1;
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
        const auth = await authResponse(request);
        if (auth) return auth;

        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const socketData = await validateSocket(request, url);
          if (!socketData) return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
          if (server.upgrade(request, { data: socketData })) return undefined;
          return new Response("websocket upgrade failed", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
        }

        const canonical = await handleCanonicalProxyRequest(url, request);
        if (canonical) return canonical;

        const staticResponse = await serveStatic(url.pathname);
        if (staticResponse) return staticResponse;

        return await app.fetch(request);
      },
      websocket: {
        open(ws) {
          if (ws.data.kind === "provision-term") openProvisionTermSocket(ws as ServerWebSocket<ProvisionTermSocketData>);
          else socketHandlersByKind.get(ws.data.kind)?.open?.(ws);
        },
        message(ws, message) {
          socketHandlersByKind.get(ws.data.kind)?.message?.(ws, message);
        },
        close(ws) {
          if (ws.data.kind === "provision-term") closeProvisionTermSocket(ws as ServerWebSocket<ProvisionTermSocketData>);
          else socketHandlersByKind.get(ws.data.kind)?.close?.(ws);
        },
      },
    });
    serverPort = server.port ?? port;
    break;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "EADDRINUSE" || requestedPort === 0 || !allowPortFallback) throw error;
  }
}

if (serverPort === 0) throw new Error(`No available port found from ${requestedPort} through ${requestedPort + maxPortAttempts - 1}`);

console.log(`${atelierName} web listening on http://${hostname}:${serverPort}`);
