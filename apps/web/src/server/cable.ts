import { AtelierCoreError, type AtelierEventBus } from "@atelier/core";
import {
  decodeCableClientMessage,
  serializeCableIdentifier,
  type CableChannelAdapter,
  type CableClientMessage,
  type CableIdentifier,
  type CableServerMessage,
} from "@atelier/shared";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

export interface CableSocketData {
  kind: "cable";
  connectionId: string;
}

export interface CableSocket {
  send(message: string): number;
  getBufferedAmount?(): number;
  close?(code: number, reason: string): void;
}

type SocketSubscriptionAttempt = {
  ws: CableSocket;
  identifier: CableIdentifier;
  key: string;
  subscriptionId: string;
  confirmed: boolean;
  unsubscribe?: () => void;
};

export interface CableServerOptions {
  registry: WorkspaceRegistry;
  events: AtelierEventBus;
  channels?: CableChannelAdapter[];
  logError?: (message: string) => void;
}

export interface CableConnectionStats {
  sockets: number;
  subscriptions: Record<string, number>;
  upstreams: Record<string, number>;
}

export interface CableServer {
  validate(request: Request, url: URL): CableSocketData | undefined;
  open(ws: CableSocket, data: CableSocketData): void;
  message(ws: CableSocket, message: string | Buffer): void;
  close(ws: CableSocket): void;
  stats(): CableConnectionStats;
}

function textMessage(message: string | Buffer): string {
  return Buffer.isBuffer(message) ? message.toString() : message;
}

function send(ws: CableSocket, message: CableServerMessage): void {
  if ((ws.getBufferedAmount?.() ?? 0) > 1024 * 1024) {
    ws.close?.(1013, "Live updates exceeded delivery capacity; reconnect for a snapshot");
    return;
  }
  ws.send(JSON.stringify(message));
}

export function createCableServer(options: CableServerOptions): CableServer {
  const channels = new Map<string, CableChannelAdapter>();
  for (const channel of options.channels ?? []) {
    if (channels.has(channel.name)) throw new Error(`Cable channel already registered: ${channel.name}`);
    channels.set(channel.name, channel);
  }
  const channelFor = (identifier: CableIdentifier) => channels.get(identifier.channel === "module" ? identifier.name : identifier.channel);
  const logError = options.logError ?? ((message: string) => console.error(message));
  const connections = new Map<CableSocket, { id: string; attempts: Map<string, SocketSubscriptionAttempt> }>();
  const attemptsByIdentifier = new Map<string, Set<SocketSubscriptionAttempt>>();
  const heartbeat = setInterval(() => {
    const time = Date.now();
    for (const ws of connections.keys()) send(ws, { type: "ping", time });
  }, 30_000);
  heartbeat.unref?.();

  function authorize(identifier: CableIdentifier): void {
    if (identifier.channel === "shell") return;
    if (identifier.channel === "module") {
      if (!options.registry.get(identifier.workspaceId)) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${identifier.workspaceId}`);
    }
  }

  function attemptIsCurrent(attempt: SocketSubscriptionAttempt): boolean {
    return connections.get(attempt.ws)?.attempts.get(attempt.key) === attempt;
  }

  function releaseAttempt(attempt: SocketSubscriptionAttempt): void {
    const unsubscribe = attempt.unsubscribe;
    attempt.unsubscribe = undefined;
    unsubscribe?.();

    const attempts = attemptsByIdentifier.get(attempt.key);
    attempts?.delete(attempt);
    if (attempts?.size === 0) attemptsByIdentifier.delete(attempt.key);

    const socketAttempts = connections.get(attempt.ws)?.attempts;
    if (socketAttempts?.get(attempt.key) === attempt) socketAttempts.delete(attempt.key);
  }

  function confirm(attempt: SocketSubscriptionAttempt, html = ""): void {
    if (!attemptIsCurrent(attempt)) return;
    attempt.confirmed = true;
    const message: Extract<CableServerMessage, { type: "confirm_subscription" }> = {
      type: "confirm_subscription",
      identifier: attempt.identifier,
      subscriptionId: attempt.subscriptionId,
    };
    if (html) message.html = html;
    send(attempt.ws, message);

  }

  function reject(attempt: SocketSubscriptionAttempt, reason: string): void {
    if (!attemptIsCurrent(attempt)) return;
    releaseAttempt(attempt);
    if (!connections.has(attempt.ws)) return;
    send(attempt.ws, { type: "reject_subscription", identifier: attempt.identifier, subscriptionId: attempt.subscriptionId, reason });
    logError(`cable message failed: ${reason}`);
  }

  async function initializeChannelAttempt(attempt: SocketSubscriptionAttempt): Promise<void> {
    const identifier = attempt.identifier;
    try {
      const channel = channelFor(identifier);
      if (!channel) throw new Error("Unregistered Cable channel");
      const subscription = await channel.subscribe(identifier, (html) => {
        if (!attemptIsCurrent(attempt)) return;
        if (!attempt.confirmed) confirm(attempt, html);
        else if (html) send(attempt.ws, { type: "turbo_stream", identifier, subscriptionId: attempt.subscriptionId, html });
      }, options.events);
      if (!attemptIsCurrent(attempt)) { subscription.unsubscribe(); return; }
      attempt.unsubscribe = () => subscription.unsubscribe();
    } catch (error) {
      reject(attempt, error instanceof Error ? error.message : String(error));
    }
  }

  function subscribe(ws: CableSocket, identifier: CableIdentifier, subscriptionId: string): void {
    const socketAttempts = connections.get(ws)?.attempts;
    if (!socketAttempts) return;
    const key = serializeCableIdentifier(identifier);
    const previous = socketAttempts.get(key);
    if (previous) releaseAttempt(previous);
    const attempt: SocketSubscriptionAttempt = { ws, identifier, key, subscriptionId, confirmed: false };
    socketAttempts.set(key, attempt);

    if (identifier.channel !== "agent" && identifier.channel !== "agent-turn") {
      try {
        authorize(identifier);
      } catch (error) {
        reject(attempt, error instanceof Error ? error.message : String(error));
        return;
      }
    }
    let attempts = attemptsByIdentifier.get(key);
    if (!attempts) attemptsByIdentifier.set(key, attempts = new Set());
    attempts.add(attempt);
    void initializeChannelAttempt(attempt);
  }

  function unsubscribe(ws: CableSocket, identifier: CableIdentifier, subscriptionId: string): void {
    const key = serializeCableIdentifier(identifier);
    const attempt = connections.get(ws)?.attempts.get(key);
    if (attempt?.subscriptionId === subscriptionId) releaseAttempt(attempt);
  }

  function close(ws: CableSocket): void {
    const connection = connections.get(ws);
    if (connection) options.registry.disconnect(connection.id);
    connections.delete(ws);
    for (const attempt of connection?.attempts.values() ?? []) releaseAttempt(attempt);
  }

  function handleInboundCommand(ws: CableSocket, raw: string | Buffer): void {
    if (!connections.has(ws)) return;
    try {
      const message: CableClientMessage = decodeCableClientMessage(textMessage(raw));
      if (message.command === "visibility") options.registry.setVisibility(connections.get(ws)!.id, message.visibility);
      else if (message.command === "subscribe") subscribe(ws, message.identifier, message.subscriptionId);
      else if (message.command === "unsubscribe") unsubscribe(ws, message.identifier, message.subscriptionId);
    } catch (error) {
      if (!connections.has(ws)) return;
      const reason = error instanceof Error ? error.message : String(error);
      send(ws, { type: "error", message: reason });
      logError(`cable message failed: ${reason}`);
    }
  }

  return {
    validate(_request, url) {
      if (url.pathname !== "/cable") return undefined;
      return { kind: "cable", connectionId: crypto.randomUUID() };
    },
    open(ws, data) {
      connections.set(ws, { id: data.connectionId, attempts: new Map() });
      send(ws, { type: "welcome", connectionId: data.connectionId });
    },
    message(ws, raw) {
      handleInboundCommand(ws, raw);
    },
    close,
    stats() {
      const subscriptions: Record<string, number> = {};
      for (const [key, set] of attemptsByIdentifier) subscriptions[key] = set.size;
      const upstreams: Record<string, number> = {};
      for (const [key, attempts] of attemptsByIdentifier) {
        upstreams[key] = attempts.size;
      }
      return { sockets: connections.size, subscriptions, upstreams };
    },
  };
}
