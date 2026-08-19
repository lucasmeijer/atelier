import { AtelierCoreError, type AtelierEventBus } from "@atelier/core";
import { getWorkspaceAgentRuntime, listWorkspaceAgents } from "@atelier/agent/server";
import {
  serializeCableIdentifier,
  type CableClientMessage,
  type CableIdentifier,
  type CableServerMessage,
} from "@atelier/shared";
import { decodeCableClientMessage } from "./cable-message.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

export interface CableSocketData {
  kind: "cable";
  connectionId: string;
}

export interface CableSocket {
  data: CableSocketData;
  send(message: string): number;
}

type UpstreamSubscription = {
  refCount: number;
  unsubscribe: () => void;
};

export interface CableServerOptions {
  registry: WorkspaceRegistry;
  events: AtelierEventBus;
  shellSnapshot?: () => string | Promise<string>;
  logError?: (message: string) => void;
}

export interface CableConnectionStats {
  sockets: number;
  subscriptions: Record<string, number>;
  upstreams: Record<string, number>;
}

export interface CableServer {
  validate(request: Request, url: URL): CableSocketData | undefined;
  open(ws: CableSocket): void;
  message(ws: CableSocket, message: string | Buffer): void;
  close(ws: CableSocket): void;
  broadcast(identifier: CableIdentifier, html: string): void;
  stats(): CableConnectionStats;
}

function textMessage(message: string | Buffer): string {
  return Buffer.isBuffer(message) ? message.toString() : message;
}

function send(ws: CableSocket, message: CableServerMessage): void {
  ws.send(JSON.stringify(message));
}

async function requireAgent(workspaceId: string, label: string) {
  const agent = (await listWorkspaceAgents(workspaceId)).find((candidate) => candidate.label === label);
  if (!agent) throw new AtelierCoreError("agent_not_found", `agent not found: ${label}`);
  return agent;
}

export function createCableServer(options: CableServerOptions): CableServer {
  const logError = options.logError ?? ((message: string) => console.error(message));
  const sockets = new Set<CableSocket>();
  const socketsByIdentifier = new Map<string, Set<CableSocket>>();
  const identifiersBySocket = new WeakMap<CableSocket, Set<string>>();
  const upstreamByIdentifier = new Map<string, UpstreamSubscription>();
  const heartbeat = setInterval(() => {
    const time = Date.now();
    for (const ws of sockets) send(ws, { type: "ping", time });
  }, 30_000);
  heartbeat.unref?.();

  async function authorize(identifier: CableIdentifier): Promise<void> {
    if (identifier.channel === "shell" || identifier.channel === "update") return;
    if (identifier.channel === "workspace") {
      if (!options.registry.get(identifier.workspaceId)) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${identifier.workspaceId}`);
      return;
    }
    await requireAgent(identifier.workspaceId, identifier.label);
  }

  async function agentRuntime(identifier: Extract<CableIdentifier, { channel: "agent" }>) {
    // Cable can initialize the runtime first, so it must provide the events used by agent tools.
    return await getWorkspaceAgentRuntime(await requireAgent(identifier.workspaceId, identifier.label), { events: options.events });
  }

  async function snapshot(identifier: CableIdentifier, upTo?: string): Promise<{ html: string; cursor?: string }> {
    if (identifier.channel === "shell") return { html: await options.shellSnapshot?.() ?? "" };
    if (identifier.channel === "agent") return await (await agentRuntime(identifier)).snapshotStream(upTo);
    return { html: "" };
  }

  async function ensureUpstream(identifier: CableIdentifier): Promise<void> {
    if (identifier.channel !== "agent") return;
    const key = serializeCableIdentifier(identifier);
    const existing = upstreamByIdentifier.get(key);
    if (existing) {
      existing.refCount += 1;
      return;
    }
    const runtime = await agentRuntime(identifier);
    const unsubscribe = runtime.subscribe((html, cursor) => broadcast(identifier, html, cursor));
    upstreamByIdentifier.set(key, { refCount: 1, unsubscribe });
  }

  function releaseUpstream(key: string): void {
    const existing = upstreamByIdentifier.get(key);
    if (!existing) return;
    existing.refCount -= 1;
    if (existing.refCount > 0) return;
    existing.unsubscribe();
    upstreamByIdentifier.delete(key);
  }

  async function subscribe(ws: CableSocket, identifier: CableIdentifier, upTo?: string): Promise<void> {
    const key = serializeCableIdentifier(identifier);
    await authorize(identifier);

    let socketIdentifiers = identifiersBySocket.get(ws);
    if (!socketIdentifiers) identifiersBySocket.set(ws, socketIdentifiers = new Set());
    if (!socketIdentifiers.has(key)) {
      socketIdentifiers.add(key);
      let identifierSockets = socketsByIdentifier.get(key);
      if (!identifierSockets) socketsByIdentifier.set(key, identifierSockets = new Set());
      identifierSockets.add(ws);
      await ensureUpstream(identifier);
    }

    const current = await snapshot(identifier, upTo);
    send(ws, { type: "confirm_subscription", identifier });
    if (current.html) {
      const message: Extract<CableServerMessage, { type: "turbo_stream" }> = { type: "turbo_stream", identifier, html: current.html };
      if (current.cursor) message.cursor = current.cursor;
      send(ws, message);
    }
  }

  function unsubscribe(ws: CableSocket, identifier: CableIdentifier): void {
    const key = serializeCableIdentifier(identifier);
    const socketIdentifiers = identifiersBySocket.get(ws);
    if (!socketIdentifiers?.delete(key)) return;
    const identifierSockets = socketsByIdentifier.get(key);
    identifierSockets?.delete(ws);
    releaseUpstream(key);
    if (identifierSockets?.size === 0) socketsByIdentifier.delete(key);
  }

  function broadcast(identifier: CableIdentifier, html: string, cursor?: string): void {
    if (!html) return;
    const key = serializeCableIdentifier(identifier);
    const message: Extract<CableServerMessage, { type: "turbo_stream" }> = { type: "turbo_stream", identifier, html };
    if (cursor) message.cursor = cursor;
    for (const ws of socketsByIdentifier.get(key) ?? []) send(ws, message);
  }

  function close(ws: CableSocket): void {
    sockets.delete(ws);
    for (const key of identifiersBySocket.get(ws) ?? []) {
      const identifierSockets = socketsByIdentifier.get(key);
      identifierSockets?.delete(ws);
      releaseUpstream(key);
      if (identifierSockets?.size === 0) socketsByIdentifier.delete(key);
    }
    identifiersBySocket.delete(ws);
  }

  return {
    validate(_request, url) {
      if (url.pathname !== "/cable") return undefined;
      return { kind: "cable", connectionId: crypto.randomUUID() };
    },
    open(ws) {
      sockets.add(ws);
      send(ws, { type: "welcome", connectionId: ws.data.connectionId });
    },
    message(ws, raw) {
      void (async () => {
        let message: CableClientMessage | undefined;
        try {
          message = decodeCableClientMessage(textMessage(raw));
          if (message.command === "subscribe") await subscribe(ws, message.identifier, message.upTo);
          else if (message.command === "unsubscribe") unsubscribe(ws, message.identifier);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (message?.command === "subscribe") {
            send(ws, { type: "reject_subscription", identifier: message.identifier, reason });
          } else {
            send(ws, { type: "error", message: reason });
          }
          logError(`cable message failed: ${reason}`);
        }
      })();
    },
    close,
    broadcast,
    stats() {
      const subscriptions: Record<string, number> = {};
      for (const [key, set] of socketsByIdentifier) subscriptions[key] = set.size;
      const upstreams: Record<string, number> = {};
      for (const [key, upstream] of upstreamByIdentifier) upstreams[key] = upstream.refCount;
      return { sockets: sockets.size, subscriptions, upstreams };
    },
  };
}
