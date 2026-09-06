import { AtelierCoreError, type AtelierEventBus } from "@atelier/core";
import {
  decodeCableClientMessage,
  serializeCableIdentifier,
  type CableClientMessage,
  type CableChannelAdapter,
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
}

type SocketSubscriptionAttempt = {
  ws: CableSocket;
  identifier: CableIdentifier;
  key: string;
  subscriptionId: string;
  confirmed: boolean;
  bufferedHtml: string[];
  unsubscribe?: () => void;
};

export interface CableServerOptions {
  registry: WorkspaceRegistry;
  events: AtelierEventBus;
  shellSnapshot?: () => string | Promise<string>;
  channels?: CableChannelAdapter[];
  logError?: (message: string) => void;
}

export interface CableConnectionStats {
  sockets: number;
  subscriptions: Record<string, number>;
  upstreams: Record<string, number>;
}

export interface CableBroadcastOptions {
  exceptConnectionId?: string;
  onlyConnectionId?: string;
}

export interface CableServer {
  validate(request: Request, url: URL): CableSocketData | undefined;
  open(ws: CableSocket, data: CableSocketData): void;
  message(ws: CableSocket, message: string | Buffer): void;
  close(ws: CableSocket): void;
  broadcast(identifier: CableIdentifier, html: string, options?: CableBroadcastOptions): void;
  stats(): CableConnectionStats;
}

function textMessage(message: string | Buffer): string {
  return Buffer.isBuffer(message) ? message.toString() : message;
}

function send(ws: CableSocket, message: CableServerMessage): void {
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
  const sockets = new Set<CableSocket>();
  const connectionIdsBySocket = new WeakMap<CableSocket, string>();
  const attemptsByIdentifier = new Map<string, Set<SocketSubscriptionAttempt>>();
  const attemptsBySocket = new WeakMap<CableSocket, Map<string, SocketSubscriptionAttempt>>();
  const heartbeat = setInterval(() => {
    const time = Date.now();
    for (const ws of sockets) send(ws, { type: "ping", time });
  }, 30_000);
  heartbeat.unref?.();

  function authorize(identifier: CableIdentifier): void {
    if (identifier.channel === "shell") return;
    if (identifier.channel === "workspace" || identifier.channel === "module") {
      if (!options.registry.get(identifier.workspaceId)) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${identifier.workspaceId}`);
    }
  }

  function attemptIsCurrent(attempt: SocketSubscriptionAttempt): boolean {
    return sockets.has(attempt.ws) && attemptsBySocket.get(attempt.ws)?.get(attempt.key) === attempt;
  }

  function releaseAttempt(attempt: SocketSubscriptionAttempt): void {
    attempt.bufferedHtml.length = 0;
    const unsubscribe = attempt.unsubscribe;
    attempt.unsubscribe = undefined;
    unsubscribe?.();

    const attempts = attemptsByIdentifier.get(attempt.key);
    attempts?.delete(attempt);
    if (attempts?.size === 0) attemptsByIdentifier.delete(attempt.key);

    const socketAttempts = attemptsBySocket.get(attempt.ws);
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
    for (const buffered of attempt.bufferedHtml.splice(0)) {
      if (!attemptIsCurrent(attempt)) return;
      send(attempt.ws, { type: "turbo_stream", identifier: attempt.identifier, subscriptionId: attempt.subscriptionId, html: buffered });
    }
  }

  function reject(attempt: SocketSubscriptionAttempt, reason: string): void {
    if (!attemptIsCurrent(attempt)) return;
    releaseAttempt(attempt);
    if (!sockets.has(attempt.ws)) return;
    send(attempt.ws, { type: "reject_subscription", identifier: attempt.identifier, subscriptionId: attempt.subscriptionId, reason });
    logError(`cable message failed: ${reason}`);
  }

  async function initializeNonAgentAttempt(attempt: SocketSubscriptionAttempt): Promise<void> {
    try {
      const html = attempt.identifier.channel === "shell" ? await options.shellSnapshot?.() ?? "" : "";
      confirm(attempt, html);
    } catch (error) {
      reject(attempt, error instanceof Error ? error.message : String(error));
    }
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
      await subscription.ready;
    } catch (error) {
      reject(attempt, error instanceof Error ? error.message : String(error));
    }
  }

  function subscribe(ws: CableSocket, identifier: CableIdentifier, subscriptionId: string): void {
    if (!sockets.has(ws)) return;
    const key = serializeCableIdentifier(identifier);
    let socketAttempts = attemptsBySocket.get(ws);
    if (!socketAttempts) attemptsBySocket.set(ws, socketAttempts = new Map());
    const previous = socketAttempts.get(key);
    if (previous) releaseAttempt(previous);
    const attempt: SocketSubscriptionAttempt = { ws, identifier, key, subscriptionId, confirmed: false, bufferedHtml: [] };
    socketAttempts.set(key, attempt);

    if (identifier.channel !== "agent") {
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
    if (identifier.channel === "agent" || identifier.channel === "module") void initializeChannelAttempt(attempt);
    else void initializeNonAgentAttempt(attempt);
  }

  function unsubscribe(ws: CableSocket, identifier: CableIdentifier, subscriptionId: string): void {
    const key = serializeCableIdentifier(identifier);
    const attempt = attemptsBySocket.get(ws)?.get(key);
    if (attempt?.subscriptionId === subscriptionId) releaseAttempt(attempt);
  }

  function broadcast(identifier: CableIdentifier, html: string, options: CableBroadcastOptions = {}): void {
    if (!html) return;
    if (options.exceptConnectionId && options.onlyConnectionId) throw new Error("Cable broadcast cannot combine exceptConnectionId and onlyConnectionId");
    if (identifier.channel === "module" || identifier.channel === "agent") throw new Error("Channel updates must be published through the live-presentation interface");
    const key = serializeCableIdentifier(identifier);
    for (const attempt of attemptsByIdentifier.get(key) ?? []) {
      if (!attemptIsCurrent(attempt)) continue;
      const connectionId = connectionIdsBySocket.get(attempt.ws);
      if (options.exceptConnectionId && connectionId === options.exceptConnectionId) continue;
      if (options.onlyConnectionId && connectionId !== options.onlyConnectionId) continue;
      if (attempt.confirmed) send(attempt.ws, { type: "turbo_stream", identifier, subscriptionId: attempt.subscriptionId, html });
      else attempt.bufferedHtml.push(html);
    }
  }

  function close(ws: CableSocket): void {
    sockets.delete(ws);
    for (const attempt of [...(attemptsBySocket.get(ws)?.values() ?? [])]) releaseAttempt(attempt);
    attemptsBySocket.delete(ws);
  }

  function handleInboundCommand(ws: CableSocket, raw: string | Buffer): void {
    if (!sockets.has(ws)) return;
    try {
      const message: CableClientMessage = decodeCableClientMessage(textMessage(raw));
      if (message.command === "subscribe") subscribe(ws, message.identifier, message.subscriptionId);
      else if (message.command === "unsubscribe") unsubscribe(ws, message.identifier, message.subscriptionId);
    } catch (error) {
      if (!sockets.has(ws)) return;
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
      sockets.add(ws);
      connectionIdsBySocket.set(ws, data.connectionId);
      send(ws, { type: "welcome", connectionId: data.connectionId });
    },
    message(ws, raw) {
      handleInboundCommand(ws, raw);
    },
    close,
    broadcast,
    stats() {
      const subscriptions: Record<string, number> = {};
      for (const [key, set] of attemptsByIdentifier) subscriptions[key] = set.size;
      const upstreams: Record<string, number> = {};
      for (const [key, attempts] of attemptsByIdentifier) {
        if (["agent", "module"].includes(attempts.values().next().value?.identifier.channel ?? "")) upstreams[key] = attempts.size;
      }
      return { sockets: sockets.size, subscriptions, upstreams };
    },
  };
}
