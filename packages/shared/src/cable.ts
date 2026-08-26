import type { JsonValue } from "@atelier/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export interface CableSubscriptionOptions {
  /** The latest server snapshot already represented in this client's DOM. */
  upTo?: string;
  /** Runs after the server's current snapshot has been applied to the DOM. */
  onSynchronized?: () => void;
}

const cableIdentifierSchema = Type.Union([
  Type.Object({ channel: Type.Literal("shell") }),
  Type.Object({ channel: Type.Literal("workspace"), workspaceId: Type.String({ minLength: 1 }) }),
  Type.Object({ channel: Type.Literal("agent"), workspaceId: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1 }) }),
]);

const cableClientMessageSchema = Type.Union([
  Type.Object({ command: Type.Literal("subscribe"), identifier: cableIdentifierSchema, upTo: Type.Optional(Type.String()) }),
  Type.Object({ command: Type.Literal("unsubscribe"), identifier: cableIdentifierSchema }),
  Type.Object({ command: Type.Literal("pong"), time: Type.Optional(Type.Number()) }),
]);

const cableServerMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal("welcome"), connectionId: Type.String() }),
  Type.Object({ type: Type.Literal("confirm_subscription"), identifier: cableIdentifierSchema, html: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()) }),
  Type.Object({ type: Type.Literal("reject_subscription"), identifier: cableIdentifierSchema, reason: Type.String() }),
  Type.Object({ type: Type.Literal("turbo_stream"), identifier: cableIdentifierSchema, html: Type.String(), cursor: Type.Optional(Type.String()) }),
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

export interface AtelierCableClient {
  subscribe(identifier: CableIdentifier, options?: CableSubscriptionOptions): void;
  unsubscribe(identifier: CableIdentifier): void;
  connected(): boolean;
}

function requireNonEmpty(value: string, message: string): string {
  if (!(value.length > 0)) throw new Error(message);
  return value;
}

export const CableTopics = {
  shell(): CableIdentifier { return { channel: "shell" }; },
  workspace(workspaceId: string): CableIdentifier {
    return { channel: "workspace", workspaceId: requireNonEmpty(workspaceId, "workspace identifier must not be empty") };
  },
  agent(workspaceId: string, label: string): CableIdentifier {
    return {
      channel: "agent",
      workspaceId: requireNonEmpty(workspaceId, "workspace identifier must not be empty"),
      label: requireNonEmpty(label, "agent label must not be empty"),
    };
  },
};

export function serializeCableIdentifier(identifier: CableIdentifier): string {
  switch (identifier.channel) {
    case "shell": return JSON.stringify(["shell"]);
    case "workspace": return JSON.stringify(["workspace", requireNonEmpty(identifier.workspaceId, "workspace identifier must not be empty")]);
    case "agent": return JSON.stringify([
      "agent",
      requireNonEmpty(identifier.workspaceId, "workspace identifier must not be empty"),
      requireNonEmpty(identifier.label, "agent label must not be empty"),
    ]);
    default: throw new Error("unsupported cable identifier");
  }
}
