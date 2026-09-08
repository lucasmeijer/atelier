import type { JsonValue } from "@atelier/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export interface CableSubscriptionOptions {
  /** Runs after the server's authoritative initial update has been applied to the DOM. */
  onReady?: () => void;
  /** Runs when a previously ready subscription loses its Cable connection. */
  onDisconnected?: () => void;
}

const cableIdentifierSchema = Type.Union([
  Type.Object({ channel: Type.Literal("shell") }),
  Type.Object({ channel: Type.Literal("workspace"), workspaceId: Type.String({ minLength: 1 }) }),
  Type.Object({ channel: Type.Literal("module"), name: Type.String({ minLength: 1 }), workspaceId: Type.String({ minLength: 1 }), params: Type.Record(Type.String(), Type.String()) }),
  Type.Object({ channel: Type.Literal("agent"), workspaceId: Type.String({ minLength: 1 }), conversationId: Type.String({ minLength: 1 }) }),
  Type.Object({ channel: Type.Literal("agent-turn"), workspaceId: Type.String({ minLength: 1 }), conversationId: Type.String({ minLength: 1 }), turnId: Type.String({ minLength: 1 }), branchId: Type.String({ minLength: 1 }) }),
]);

const subscriptionIdSchema = Type.String({ minLength: 1 });

const cableClientMessageSchema = Type.Union([
  Type.Object({ command: Type.Literal("subscribe"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema }),
  Type.Object({ command: Type.Literal("unsubscribe"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema }),
  Type.Object({ command: Type.Literal("pong"), time: Type.Optional(Type.Number()) }),
]);

const cableServerMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal("welcome"), connectionId: Type.String() }),
  Type.Object({ type: Type.Literal("confirm_subscription"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema, html: Type.Optional(Type.String()) }),
  Type.Object({ type: Type.Literal("reject_subscription"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema, reason: Type.String() }),
  Type.Object({ type: Type.Literal("turbo_stream"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema, html: Type.String() }),
  Type.Object({ type: Type.Literal("ping"), time: Type.Number() }),
  Type.Object({ type: Type.Literal("error"), message: Type.String() }),
]);

export type CableIdentifier = Static<typeof cableIdentifierSchema>;
export type CableClientMessage = Static<typeof cableClientMessageSchema>;
export type CableServerMessage = Static<typeof cableServerMessageSchema>;

function parseJson(text: string, invalidJsonMessage: string): JsonValue {
  let encoded: JsonValue;
  try {
    encoded = JSON.parse(text);
  } catch {
    throw new Error(invalidJsonMessage);
  }
  return encoded;
}

export function decodeCableClientMessage(text: string): CableClientMessage {
  const encoded = parseJson(text, "cable message must be valid JSON");
  try {
    return Value.Parse(cableClientMessageSchema, Value.Clean(cableClientMessageSchema, encoded));
  } catch {
    throw new Error("unsupported cable message");
  }
}

export function decodeCableServerMessage(text: string): CableServerMessage {
  const encoded = parseJson(text, "cable server message must be valid JSON");
  try {
    return Value.Parse(cableServerMessageSchema, Value.Clean(cableServerMessageSchema, encoded));
  } catch {
    throw new Error("unsupported cable server message");
  }
}

export interface CableSubscription {
  unsubscribe(): void;
}

export interface AtelierCableClient {
  subscribe(identifier: CableIdentifier, options?: CableSubscriptionOptions): CableSubscription;
  connected(): boolean;
  connectionId(): string | undefined;
}

export const atelierCableConnectionHeader = "Atelier-Cable-Connection-Id";

function requireNonEmpty(value: string, message: string): string {
  if (!(value.length > 0)) throw new Error(message);
  return value;
}

export const CableTopics = {
  shell(): CableIdentifier { return { channel: "shell" }; },
  workspace(workspaceId: string): CableIdentifier {
    return { channel: "workspace", workspaceId: requireNonEmpty(workspaceId, "workspace identifier must not be empty") };
  },
  module(name: string, workspaceId: string, params: Record<string, string> = {}): CableIdentifier {
    return { channel: "module", name: requireNonEmpty(name, "channel name must not be empty"), workspaceId: requireNonEmpty(workspaceId, "workspace identifier must not be empty"), params };
  },
  agentTurn(workspaceId: string, conversationId: string, turnId: string, branchId: string): CableIdentifier {
    return {
      channel: "agent-turn",
      workspaceId: requireNonEmpty(workspaceId, "workspace identifier must not be empty"),
      conversationId: requireNonEmpty(conversationId, "agent conversation identifier must not be empty"),
      turnId: requireNonEmpty(turnId, "agent turn identifier must not be empty"),
      branchId: requireNonEmpty(branchId, "agent branch identifier must not be empty"),
    };
  },
  agent(workspaceId: string, conversationId: string): CableIdentifier {
    return {
      channel: "agent",
      workspaceId: requireNonEmpty(workspaceId, "workspace identifier must not be empty"),
      conversationId: requireNonEmpty(conversationId, "agent conversation identifier must not be empty"),
    };
  },
};

export function serializeCableIdentifier(identifier: CableIdentifier): string {
  switch (identifier.channel) {
    case "shell": return JSON.stringify(["shell"]);
    case "workspace": return JSON.stringify(["workspace", requireNonEmpty(identifier.workspaceId, "workspace identifier must not be empty")]);
    case "module": return JSON.stringify(["module", identifier.name, identifier.workspaceId, Object.entries(identifier.params).sort(([a], [b]) => a.localeCompare(b))]);
    case "agent-turn": return JSON.stringify([
      identifier.channel,
      requireNonEmpty(identifier.workspaceId, "workspace identifier must not be empty"),
      requireNonEmpty(identifier.conversationId, "agent conversation identifier must not be empty"),
      requireNonEmpty(identifier.turnId, "agent turn identifier must not be empty"),
      requireNonEmpty(identifier.branchId, "agent branch identifier must not be empty"),
    ]);
    case "agent": return JSON.stringify([
      identifier.channel,
      requireNonEmpty(identifier.workspaceId, "workspace identifier must not be empty"),
      requireNonEmpty(identifier.conversationId, "agent conversation identifier must not be empty"),
    ]);
    default: throw new Error("unsupported cable identifier");
  }
}

export interface CableChannelSubscription {
  readonly ready: Promise<void>;
  unsubscribe(): void;
}

/** The adapter validates its parameters and access before publishing its first snapshot.
 * Cable owns confirmation, cancellation races, incremental delivery and error reporting. */
export interface CableChannelAdapter {
  name: string;
  subscribe(identifier: CableIdentifier, listener: (html: string) => void, events: import("@atelier/core").AtelierEventBus): CableChannelSubscription | Promise<CableChannelSubscription>;
}
