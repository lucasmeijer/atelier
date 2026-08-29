import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ServerWebSocket } from "bun";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createAtelierEventBus, getAtelierRuntimeContext } from "@atelier/core";
import { attachHostObservableTerminal, observableTerminalCols, observableTerminalRows, type IPty } from "@atelier/observable-terminal/server";
import { createWorkspace, deleteWorkspace, isWorkspaceRunning, listWorkspaces, resolveWorkspace, setWorkspaceContainerRunning, workspaceSetupProvisioningHook } from "@atelier/workspace";
import type { WorkspaceDeleteSafetyIssue } from "@atelier/projects";
import { atelierName, CableTopics, escapeHtml, type WorkspaceAppBackend, type WorkspaceAppRef, type WorkspaceServerAppResolver, type WorkspaceServerProvisioningHook, type WorkspaceServerSocketHandler, type WorkspaceServerSocketSession } from "@atelier/shared";
import {
  createFileOriginIdentityStore,
  createTailscaleOriginPublisher,
  createWorkspaceIngress,
  publicOriginPortRangeFromEnv,
  StoppedWorkspaceError,
  type OriginPublisher,
} from "@atelier/proxy-ingress/server";
import { createWebApp, type WebApp } from "./app.ts";
import { parseAssetManifest } from "./asset-manifest.ts";
import { createCableServer, type CableSocketData } from "./cable.ts";
import { legacyStaticFiles } from "./static-files.ts";
import { createFileWorkspaceActivityStore, createFileWorkspaceDeletionStore, createFileWorkspaceUnreadStore, createWorkspaceRegistry } from "./workspace-registry.ts";
import { workspaceModules } from "./workspace-modules.ts";

const requestedPort = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "0.0.0.0";
const allowPortFallback = process.env.ATELIER_PORT_FALLBACK === "1";
const devReloadFile = process.argv.find((argument) => argument.startsWith("--atelier-dev-reload-file="))?.slice("--atelier-dev-reload-file=".length);

const authPassword = process.env.ATELIER_PASSWORD ?? "";

function displayUrl(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const formattedHost = displayHost.includes(":") && !displayHost.startsWith("[") ? `[${displayHost}]` : displayHost;
  return `http://${formattedHost}${port === 80 ? "" : `:${port}`}`;
}
const authCookieName = "atelier_session";
const authCookieMaxAgeSeconds = 60 * 60 * 24 * 30;
const authSessionPayloadSchema = Type.Object({
  expires: Type.Integer(),
  nonce: Type.String(),
});

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
    const data = Value.Parse(
      authSessionPayloadSchema,
      JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)))),
    );
    return data.expires > Math.floor(Date.now() / 1000);
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

function loginPage(next: string, error = ""): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(atelierName)}</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#172033">
<style>
  html { touch-action: manipulation; }
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
const workspaceAppResolvers: WorkspaceServerAppResolver[] = [];
const provisioningHooks: WorkspaceServerProvisioningHook[] = [workspaceSetupProvisioningHook];
const workspaceRemovedHandlers: Array<(workspaceId: string) => void | Promise<void>> = [];

const runtimeContext = getAtelierRuntimeContext();

const publicOriginPortRange = publicOriginPortRangeFromEnv();

function createOriginPublisher(): OriginPublisher | undefined {
  if (process.env.ATELIER_TAILSCALE_SERVE !== "1") return undefined;
  const publicUrl = process.env.ATELIER_PUBLIC_URL;
  if (!publicUrl) throw new Error("ATELIER_TAILSCALE_SERVE=1 requires ATELIER_PUBLIC_URL");
  const url = new URL(publicUrl);
  if (url.protocol !== "https:") throw new Error("ATELIER_TAILSCALE_SERVE=1 requires an https ATELIER_PUBLIC_URL");
  return createTailscaleOriginPublisher({ host: url.hostname, portRange: publicOriginPortRange });
}

const originPublisher = createOriginPublisher();

const registry = createWorkspaceRegistry({
  activityStore: createFileWorkspaceActivityStore(join(runtimeContext.atelierDataDir, "view-state", "workspace-activity.json")),
  unreadStore: createFileWorkspaceUnreadStore(join(runtimeContext.atelierDataDir, "view-state", "workspace-unread.json")),
  deletionStore: createFileWorkspaceDeletionStore(join(runtimeContext.atelierDataDir, "view-state", "workspace-deletions.json")),
});
let app: WebApp;
const cableServer = createCableServer({ registry, events: atelierEvents, shellSnapshot: () => app.shellSnapshot() });

app = createWebApp({
  registry,
  cable: cableServer,
  events: atelierEvents,
  devReload: devReloadFile !== undefined,
  provisioningHooks,
  workspaceRemovedHandlers,
  async provisionWorkspace(id, options) {
    await createWorkspace({ id, events: atelierEvents, init: options?.init, context: options?.context, fork: options?.fork });
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
    await atelierEvents.emit("workspace_created", { workspaceId: id, init: options?.init, context: options?.context });
    await atelierEvents.emit("workspace_provision_step", { workspaceId: id, id: "workspace.integrations", label: "Run workspace startup integrations", status: "done" });
  },
  inspectDeleteSafety: async (id) => {
    const issues: WorkspaceDeleteSafetyIssue[] = [];
    await atelierEvents.emit("workspace_delete_inspect", { workspaceId: id, issues });
    return { workspaceId: id, issues };
  },
  destroyWorkspace: async (id) => {
    await workspaceIngress.stopWorkspace(id);
    await deleteWorkspace(id, { force: true, events: atelierEvents });
  },
});

atelierEvents.on("workspace_user_activity", ({ workspaceId }) => registry.touch(workspaceId));
atelierEvents.on("workspace_title_changed", ({ workspaceId, title }) => registry.setTitle(workspaceId, title || null));
atelierEvents.on("workspace_view_unread", ({ workspaceId, viewKey, unread }) => registry.setViewUnread(workspaceId, viewKey, unread));

// Docker is the persistent truth for which workspaces exist. Restore each container to the state recorded by
// park/unpark before modules initialize, then seed the registry so startup-time contributions have rows to attach to.
const persistedWorkspaces = (await listWorkspaces()).workspaces;
await Promise.all(persistedWorkspaces.map((workspace) => setWorkspaceContainerRunning(workspace.id, !workspace.parked)));
await registry.seed(persistedWorkspaces);

for (const module of workspaceModules) {
  await module.initialize?.({
    events: atelierEvents,
    registry,
    globalSidebarContributions: app.globalSidebarContributions,
    presentWorkView: (workspaceId, reference) => app.presentWorkViewFromAgent(workspaceId, reference),
    broadcastWorkspace: (workspaceId, html) => cableServer.broadcast(CableTopics.workspace(workspaceId), html),
    deleteCurrentWorkspace: (workspaceId, force) => app.deleteCurrentWorkspaceFromAgent(workspaceId, force),
    createWorkspaceFromAgent: (workspaceId, request) => app.createWorkspaceFromAgent(workspaceId, request),
    forkCurrentWorkspaceFromAgent: (workspaceId, request) => app.forkCurrentWorkspaceFromAgent(workspaceId, request),
    registerSocketHandler: (handler) => socketHandlers.push(handler),
    registerWorkspaceAppResolver: (resolver) => workspaceAppResolvers.push(resolver),
    registerProvisioningHook: (hook) => provisioningHooks.push(hook),
    onWorkspaceRemoved: (handler) => workspaceRemovedHandlers.push(handler),
  });
}

app.resumeWorkspaceDeletions();

function contentTypeForStaticPath(pathname: string): string {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (pathname.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function requestAcceptsGzip(request: Request): boolean {
  return request.headers.get("accept-encoding")?.split(",").some((encoding) => {
    const [name, ...parameters] = encoding.split(";").map((part) => part.trim());
    return name?.toLowerCase() === "gzip" && !parameters.some((parameter) => /^q\s*=\s*0(?:\.0+)?$/i.test(parameter));
  }) ?? false;
}

async function serveStatic(pathname: string, request: Request): Promise<Response | undefined> {
  let assetCacheControl = "public, max-age=31536000, immutable";
  if (pathname === "/design-system.js") {
    const manifest = parseAssetManifest(await Bun.file(new URL("../../public/assets-manifest.json", import.meta.url)).text());
    pathname = manifest[pathname]!;
    assetCacheControl = "no-store";
  }
  if (pathname.startsWith("/assets/")) {
    const file = Bun.file(new URL(`../../public${pathname}`, import.meta.url));
    if (!(await file.exists())) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    const headers = new Headers({
      "content-type": contentTypeForStaticPath(pathname),
      "cache-control": assetCacheControl,
      "vary": "Accept-Encoding",
    });
    if (requestAcceptsGzip(request)) {
      const compressed = Bun.file(new URL(`../../public${pathname}.gz`, import.meta.url));
      if (await compressed.exists()) {
        headers.set("content-encoding", "gzip");
        return new Response(compressed, { headers });
      }
    }
    return new Response(file, { headers });
  }

  const entry = legacyStaticFiles[pathname];
  if (!entry) return undefined;
  const file = Bun.file(entry.url);
  if (!(await file.exists())) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  const headers = new Headers({ "content-type": entry.contentType });
  if (["/workspace.js", "/service-worker.js", "/manifest.webmanifest", "/design-system-catalogue.html", "/design-system.css"].includes(pathname)) headers.set("cache-control", "no-store");
  return new Response(file, { headers });
}

async function compressDynamicResponse(request: Request, response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const compressible = contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("javascript") || contentType.includes("xml");
  if (request.method === "HEAD" || !response.body || !compressible || response.headers.has("content-encoding")) return response;
  const headers = new Headers(response.headers);
  const vary = headers.get("vary")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  headers.set("vary", [...new Set([...vary, "Accept-Encoding"])].join(", "));
  if (!requestAcceptsGzip(request)) return new Response(response.body, { status: response.status, statusText: response.statusText, headers });

  const body = new Uint8Array(await response.arrayBuffer());
  headers.delete("content-length");
  if (body.byteLength < 1024) return new Response(body, { status: response.status, statusText: response.statusText, headers });
  headers.set("content-encoding", "gzip");
  return new Response(gzipSync(body, { level: 6 }), { status: response.status, statusText: response.statusText, headers });
}

interface ProvisionTermSocketData {
  kind: "provision-term";
  session: string;
  pty?: IPty;
}

type ProvisionTermSocket = Pick<ServerWebSocket<undefined>, "send" | "close">;

type WorkspaceModuleSocketData = WorkspaceServerSocketSession & { kind: "workspace-module" };
type SocketData = WorkspaceModuleSocketData | ProvisionTermSocketData | CableSocketData;

async function resolveWorkspaceApp(app: WorkspaceAppRef, requestUrl: URL): Promise<WorkspaceAppBackend | undefined> {
  for (const resolver of workspaceAppResolvers) {
    const backend = await resolver(app, requestUrl);
    if (backend) return backend;
  }
  return undefined;
}

const workspaceIngress = createWorkspaceIngress({
  hostname,
  resolveWorkspace: async (workspaceId) => {
    await resolveWorkspace(workspaceId);
    if (!await isWorkspaceRunning(workspaceId)) throw new StoppedWorkspaceError(workspaceId);
  },
  resolveApp: resolveWorkspaceApp,
  originPortRange: publicOriginPortRange,
  originPublisher,
  originIdentityStore: createFileOriginIdentityStore(),
});

async function handleCanonicalProxyRequest(url: URL, request: Request): Promise<Response | undefined> {
  const appMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/apps\/([^/]+)(\/.*)?$/);
  if (appMatch) {
    const workspaceId = decodeURIComponent(appMatch[1] ?? "");
    const appKey = decodeURIComponent(appMatch[2] ?? "");
    const path = `${appMatch[3] || "/"}${url.search}`;
    return await workspaceIngress.openCanonical({ workspaceId, appKey }, path, request);
  }

  const portMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/ports\/(\d+)(\/.*)?$/);
  if (portMatch) {
    const workspaceId = decodeURIComponent(portMatch[1] ?? "");
    const port = Number(portMatch[2]);
    const path = `${portMatch[3] || "/"}${url.search}`;
    return await workspaceIngress.openCanonical({ workspaceId, appKey: `port-${port}` }, path, request);
  }

  const fileMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/files(\/.*)$/);
  if (fileMatch) {
    const workspaceId = decodeURIComponent(fileMatch[1] ?? "");
    const path = `${decodeURIComponent(fileMatch[2] ?? "/")}${url.search}`;
    return await workspaceIngress.openCanonical({ workspaceId, appKey: "file" }, path, request);
  }

  return undefined;
}

async function validateSocket(request: Request, url: URL): Promise<SocketData | undefined> {
  const cableData = cableServer.validate(request, url);
  if (cableData) return cableData;
  const provisionMatch = url.pathname.match(/^\/provision-term\/([^/]+)\/ws$/);
  if (provisionMatch) {
    const session = decodeURIComponent(provisionMatch[1]);
    if (!session.startsWith("atelier-provision-")) return undefined;
    return { kind: "provision-term", session };
  }
  for (const handler of socketHandlers) {
    const session = await handler(url);
    if (session) return { kind: "workspace-module", ...session };
  }
  return undefined;
}

function openProvisionTermSocket(ws: ProvisionTermSocket, data: ProvisionTermSocketData): void {
  void (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const pty = attachHostObservableTerminal({ session: data.session, cols: observableTerminalCols, rows: observableTerminalRows, readonly: true, fixedSize: true });
        data.pty = pty;
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

function closeProvisionTermSocket(data: ProvisionTermSocketData): void {
  data.pty?.kill();
}

await workspaceIngress.initialize();
const maxPortAttempts = allowPortFallback ? 100 : 1;
let serverPort = 0;

for (let attempt = 0; attempt < maxPortAttempts; attempt++) {
  const port = requestedPort === 0 ? 0 : requestedPort + attempt;

  try {
    const server = Bun.serve<SocketData>({
      hostname,
      port,
      // Keep long-lived upgraded sockets and slow workspace app proxy requests
      // alive well beyond Bun's short default idle timeout.
      idleTimeout: 255,
      async fetch(request, server) {
        const url = new URL(request.url);
        const canonical = await handleCanonicalProxyRequest(url, request);
        if (canonical) return canonical;

        const auth = await authResponse(request);
        if (auth) return auth;

        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const socketData = await validateSocket(request, url);
          if (!socketData) return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
          if (server.upgrade(request, { data: socketData })) return undefined;
          return new Response("websocket upgrade failed", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
        }

        if (url.pathname === "/debug/connections" && request.method === "GET") {
          return new Response(JSON.stringify({ cable: cableServer.stats(), ingress: workspaceIngress.inspect() }, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
        }

        if (devReloadFile && url.pathname === "/__atelier_dev_reload" && request.method === "GET") {
          return new Response(Bun.file(devReloadFile), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
        }

        const staticResponse = await serveStatic(url.pathname, request);
        if (staticResponse) return staticResponse;

        return await compressDynamicResponse(request, await app.fetch(request));
      },
      websocket: {
        open(ws) {
          if (ws.data.kind === "cable") cableServer.open(ws, ws.data);
          else if (ws.data.kind === "provision-term") openProvisionTermSocket(ws, ws.data);
          else ws.data.open?.(ws);
        },
        message(ws, message) {
          if (ws.data.kind === "cable") cableServer.message(ws, message);
          else if (ws.data.kind === "workspace-module") ws.data.message?.(ws, message);
        },
        close(ws) {
          if (ws.data.kind === "cable") cableServer.close(ws);
          else if (ws.data.kind === "provision-term") closeProvisionTermSocket(ws.data);
          else ws.data.close?.(ws);
        },
      },
    });
    serverPort = server.port ?? port;
    break;
  } catch (error) {
    const addressInUse = error instanceof Error && "code" in error && error.code === "EADDRINUSE";
    if (!addressInUse || requestedPort === 0 || !allowPortFallback) throw error;
  }
}

if (serverPort === 0) throw new Error(`No available port found from ${requestedPort} through ${requestedPort + maxPortAttempts - 1}`);

console.log(`${atelierName} is available at ${process.env.ATELIER_PUBLIC_URL || displayUrl(hostname, serverPort)}`);
