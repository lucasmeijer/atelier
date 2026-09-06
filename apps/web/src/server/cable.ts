import { AtelierCoreError, type AtelierEventBus } from "@atelier/core";
import {
  getWorkspaceAgentRuntime,
  subscribeSubagentTree,
  findSubagentConversation,
  listWorkspaceAgentConversations,
  type AgentLivePresentationSubscription,
} from "@atelier/agent/server";
import {
  decodeCableClientMessage,
  serializeCableIdentifier,
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

interface CableAgentRuntime {
  subscribeLivePresentation(listener: (html: string) => void): AgentLivePresentationSubscription;
}

export interface CableServerOptions {
  registry: WorkspaceRegistry;
  events: AtelierEventBus;
  shellSnapshot?: () => string | Promise<string>;
  subscribeSubagentTree?: (workspaceId: string, rootId: string, listener: (html: string) => void) => Promise<AgentLivePresentationSubscription>;
  resolveAgentRuntime?: (workspaceId: string, conversationId: string) => Promise<CableAgentRuntime>;
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

async function requireAgentConversation(workspaceId: string, conversationId: string, events: AtelierEventBus) {
  const conversation = (await listWorkspaceAgentConversations(workspaceId)).find((candidate) => candidate.conversationId === conversationId) ?? await findSubagentConversation(workspaceId, conversationId, events);
  if (!conversation) throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${conversationId}`);
  return conversation;
}

export function createCableServer(options: CableServerOptions): CableServer {
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
    if (identifier.channel === "workspace" || identifier.channel === "subagents") {
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

  async function initializeAgentAttempt(attempt: SocketSubscriptionAttempt): Promise<void> {
    const identifier = attempt.identifier;
    if (identifier.channel !== "agent") throw new Error("Agent subscription initializer requires an Agent identifier");

    try {
      let runtime: CableAgentRuntime;
      if (options.resolveAgentRuntime) {
        runtime = await options.resolveAgentRuntime(identifier.workspaceId, identifier.conversationId);
      } else {
        const conversation = await requireAgentConversation(identifier.workspaceId, identifier.conversationId, options.events);
        if (!attemptIsCurrent(attempt)) return;
        // Cable can initialize the runtime first, so it must provide the events used by agent tools.
        runtime = await getWorkspaceAgentRuntime(conversation, { events: options.events });
      }
      if (!attemptIsCurrent(attempt)) return;
      const subscription = runtime.subscribeLivePresentation((html) => {
        if (!attemptIsCurrent(attempt)) return;
        if (!attempt.confirmed) {
          confirm(attempt, html);
        } else if (html) {
          send(attempt.ws, { type: "turbo_stream", identifier, subscriptionId: attempt.subscriptionId, html });
        }
      });
      attempt.unsubscribe = () => subscription.unsubscribe();
      if (!attemptIsCurrent(attempt)) {
        attempt.unsubscribe = undefined;
        subscription.unsubscribe();
        return;
      }
      await subscription.ready;
    } catch (error) {
      reject(attempt, error instanceof Error ? error.message : String(error));
    }
  }

  async function initializeSubagentsAttempt(attempt: SocketSubscriptionAttempt): Promise<void> {
    const identifier = attempt.identifier;
    if (identifier.channel !== "subagents") throw new Error("Subagents initializer requires a Subagents identifier");
    try {
      const subscription = await (options.subscribeSubagentTree ?? ((workspaceId, rootId, listener) => subscribeSubagentTree(workspaceId, rootId, listener, options.events)))(identifier.workspaceId, identifier.conversationId, (html) => {
        if (!attemptIsCurrent(attempt)) return;
        if (!attempt.confirmed) confirm(attempt, html);
        else if (html) send(attempt.ws, { type: "turbo_stream", identifier, subscriptionId: attempt.subscriptionId, html });
      });
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
    if (identifier.channel === "agent") void initializeAgentAttempt(attempt);
    else if (identifier.channel === "subagents") void initializeSubagentsAttempt(attempt);
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
    if (identifier.channel === "subagents") throw new Error("Subagent tree updates must be published through the tree subscription");
    if (identifier.channel === "agent") throw new Error("Agent updates must be published through the runtime live-presentation interface");
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
        if (["agent", "subagents"].includes(attempts.values().next().value?.identifier.channel ?? "")) upstreams[key] = attempts.size;
      }
      return { sockets: sockets.size, subscriptions, upstreams };
    },
  };
}
