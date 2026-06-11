import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  agentStaticFiles,
  closeAgentTermSocket,
  ensureDefaultWorkspaceAgent,
  handleAgentTermSocketMessage,
  isFakeMode,
  openAgentTermSocket,
  subscribeWorkspaceTabBusy,
  validateAgentTermSocket,
  type AgentTermSocketData,
} from "@atelier/agent/server";
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
  terminalStaticFiles,
  validateTerminalSocket,
  type TerminalSocketData,
} from "@atelier/terminal/server";
import { atelierName } from "@atelier/shared";
import { createWebApp } from "./app.ts";
import { createStreamHub } from "./stream-hub.ts";
import { createWorkspaceLayoutStore } from "./workspace-layout.ts";
import { createFileWorkspaceActivityStore, createWorkspaceRegistry } from "./workspace-registry.ts";

const requestedPort = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";

const atelierEvents = createAtelierEventBus();
registerPiConfigEvents(atelierEvents);
registerTerminalEvents(atelierEvents);

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
  async provisionWorkspace(id) {
    if (!isFakeMode()) await createWorkspace({ id });
    await ensureDefaultWorkspaceAgent(id);
    await atelierEvents.emit("workspace_created", { workspaceId: id });
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

async function serveStatic(pathname: string): Promise<Response | undefined> {
  const staticFiles: Record<string, { url: URL; contentType: string }> = {
    "/style.css": { url: new URL("../../public/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    "/workspace.js": { url: new URL("../../public/workspace.js", import.meta.url), contentType: "text/javascript; charset=utf-8" },
    ...terminalStaticFiles,
    ...agentStaticFiles,
  };
  const entry = staticFiles[pathname];
  if (!entry) return undefined;
  const file = Bun.file(entry.url);
  if (!(await file.exists())) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(file, { headers: { "content-type": entry.contentType } });
}

type SocketData = TerminalSocketData | AgentTermSocketData;

async function validateSocket(url: URL): Promise<SocketData | undefined> {
  return validateAgentTermSocket(url) ?? (await validateTerminalSocket(url));
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
        const staticResponse = await serveStatic(url.pathname);
        if (staticResponse) return staticResponse;

        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const socketData = await validateSocket(url);
          if (!socketData) return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
          if (server.upgrade(request, { data: socketData })) return undefined;
          return new Response("websocket upgrade failed", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
        }

        return await app.fetch(request);
      },
      websocket: {
        open(ws) {
          if (ws.data.kind === "terminal") openTerminalSocket(ws as ServerWebSocket<TerminalSocketData>);
          if (ws.data.kind === "agent-term") openAgentTermSocket(ws as ServerWebSocket<AgentTermSocketData>);
        },
        message(ws, message) {
          if (ws.data.kind === "terminal") handleTerminalSocketMessage(ws as ServerWebSocket<TerminalSocketData>, message);
          if (ws.data.kind === "agent-term") handleAgentTermSocketMessage(ws as ServerWebSocket<AgentTermSocketData>, message);
        },
        close(ws) {
          if (ws.data.kind === "terminal") closeTerminalSocket(ws as ServerWebSocket<TerminalSocketData>);
          if (ws.data.kind === "agent-term") closeAgentTermSocket(ws as ServerWebSocket<AgentTermSocketData>);
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
