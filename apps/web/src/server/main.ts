import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  closeAgentTermSocket,
  ensureDefaultWorkspaceAgent,
  handleAgentTermSocketMessage,
  isFakeMode,
  openAgentTermSocket,
  registerAgentEvents,
  resolveWorkspacePortProxyTarget,
  workspaceFileEndpoint,
  subscribeWorkspaceTabBusy,
  validateAgentTermSocket,
  type AgentTermSocketData,
} from "@atelier/agent/server";
import { isBrowserWorkspaceApp, resolveBrowserWorkspaceAppTarget } from "@atelier/browser/server";
import {
  createAtelierEventBus,
  createWorkspace,
  defaultDataDir,
  deleteWorkspace,
  inspectWorkspaceDeleteSafety,
  listWorkspaces,
} from "@atelier/core";
import { registerPiConfigEvents } from "@atelier/pi-config/server";
import {
  closeTerminalSocket,
  handleTerminalSocketMessage,
  openTerminalSocket,
  registerTerminalEvents,
  subscribeTerminalTabBusy,
  validateTerminalSocket,
  type TerminalSocketData,
} from "@atelier/terminal/server";
import { atelierName } from "@atelier/shared";
import {
  parseWorkspaceAppHost,
  proxyWorkspaceAppRequest,
  workspaceAppWebSocketTarget,
  type WorkspaceAppHost,
  type WorkspaceAppTargetResolver,
} from "@atelier/workspace-proxy/server";
import { resolveVSCodeWorkspaceAppTarget, vscodeAppKey } from "@atelier/vscode/server";
import { createWebApp } from "./app.ts";
import { createFileWebPreferenceStore } from "./preferences.ts";
import { createStreamHub } from "./stream-hub.ts";
import { legacyStaticFiles } from "./static-files.ts";
import { createWorkspaceLayoutStore } from "./workspace-layout.ts";
import { createFileWorkspaceActivityStore, createWorkspaceRegistry } from "./workspace-registry.ts";

const requestedPort = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "localhost";

const atelierEvents = createAtelierEventBus();
registerPiConfigEvents(atelierEvents);
registerTerminalEvents(atelierEvents);
registerAgentEvents(atelierEvents);

const registry = createWorkspaceRegistry({
  activityStore: createFileWorkspaceActivityStore(join(defaultDataDir(), "view-state", "workspace-activity.json")),
});
const hub = createStreamHub();
const layouts = createWorkspaceLayoutStore();

const app = createWebApp({
  registry,
  hub,
  layouts,
  events: atelierEvents,
  preferences: createFileWebPreferenceStore(join(defaultDataDir(), "view-state", "preferences.json")),
  async provisionWorkspace(id, options) {
    if (!isFakeMode()) await createWorkspace({ id, events: atelierEvents });
    await ensureDefaultWorkspaceAgent(id);
    await atelierEvents.emit("workspace_created", { workspaceId: id, context: options?.context });
  },
  inspectDeleteSafety: (id) => inspectWorkspaceDeleteSafety(id),
  destroyWorkspace: async (id) => {
    await deleteWorkspace(id, { force: true });
  },
});

atelierEvents.on("workspace_user_activity", ({ workspaceId }) => registry.touch(workspaceId));
atelierEvents.on("workspace_title_changed", ({ workspaceId, title }) => registry.setTitle(workspaceId, title || null));
subscribeWorkspaceTabBusy(({ workspaceId, tabKey, busy }) => registry.setTabBusy(workspaceId, tabKey, busy));
subscribeTerminalTabBusy(({ workspaceId, tabKey, busy }) => registry.setTabBusy(workspaceId, tabKey, busy));

// Docker is the persistent truth for which workspaces exist; seed the registry from it.
// In fake-agent mode (UI development without docker) we seed a demo workspace instead.
await registry.seed(isFakeMode() ? [{ id: "demo", title: "Demo workspace" }] : (await listWorkspaces()).workspaces);

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
  if (isBrowserWorkspaceApp(app.appKey)) return await resolveBrowserWorkspaceAppTarget(app, requestUrl);
  const portMatch = app.appKey.match(workspacePortAppKeyPattern);
  if (portMatch) return await resolveWorkspacePortProxyTarget(app.workspaceId, Number(portMatch[1]), requestUrl.pathname, requestUrl.search);
  throw new Error(`unknown workspace app: ${app.appKey}`);
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

        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const socketData = await validateSocket(request, url);
          if (!socketData) return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
          if (server.upgrade(request, { data: socketData })) return undefined;
          return new Response("websocket upgrade failed", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
        }

        if (appHost?.appKey === "file") return await workspaceFileEndpoint(appHost.workspaceId, decodeURIComponent(url.pathname), request);
        if (appHost) return await proxyWorkspaceAppRequest(appHost, request, resolveWorkspaceAppTarget);

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
