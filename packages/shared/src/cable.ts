export type CableIdentifier =
  | { channel: "shell" }
  | { channel: "update" }
  | { channel: "workspace"; workspaceId: string }
  | { channel: "agent"; workspaceId: string; label: string };

export interface CableSubscriptionOptions {
  /** The latest server snapshot already represented in this client's DOM. */
  upTo?: string;
}

export type CableClientMessage =
  | ({ command: "subscribe"; identifier: CableIdentifier } & CableSubscriptionOptions)
  | { command: "unsubscribe"; identifier: CableIdentifier }
  | { command: "message"; identifier: CableIdentifier; data: unknown }
  | { command: "pong"; time?: number };

export type CableServerMessage =
  | { type: "welcome"; connectionId: string }
  | { type: "confirm_subscription"; identifier: CableIdentifier }
  | { type: "reject_subscription"; identifier: CableIdentifier; reason: string }
  | { type: "turbo_stream"; identifier: CableIdentifier; html: string; cursor?: string }
  | { type: "ping"; time: number }
  | { type: "error"; message: string };

export interface AtelierCableClient {
  subscribe(identifier: CableIdentifier, options?: CableSubscriptionOptions): void;
  unsubscribe(identifier: CableIdentifier): void;
  send(identifier: CableIdentifier, data: unknown): void;
  connected(): boolean;
}

export const CableTopics = {
  shell(): CableIdentifier { return { channel: "shell" }; },
  update(): CableIdentifier { return { channel: "update" }; },
  workspace(workspaceId: string): CableIdentifier { return { channel: "workspace", workspaceId }; },
  agent(workspaceId: string, label: string): CableIdentifier { return { channel: "agent", workspaceId, label }; },
};

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCableIdentifier(value: unknown): CableIdentifier {
  if (!isObject(value)) throw new Error("identifier must be an object");
  if (!("channel" in value)) throw new Error("unsupported cable identifier");
  if (value.channel === "shell") return { channel: "shell" };
  if (value.channel === "update") return { channel: "update" };
  if (value.channel === "workspace" && "workspaceId" in value && typeof value.workspaceId === "string" && value.workspaceId.length > 0) {
    return { channel: "workspace", workspaceId: value.workspaceId };
  }
  if (value.channel === "agent" && "workspaceId" in value && typeof value.workspaceId === "string" && value.workspaceId.length > 0 && "label" in value && typeof value.label === "string" && value.label.length > 0) {
    return { channel: "agent", workspaceId: value.workspaceId, label: value.label };
  }
  throw new Error("unsupported cable identifier");
}

export function parseCableClientMessage(value: unknown): CableClientMessage {
  if (!isObject(value) || !("command" in value)) throw new Error("cable message must be an object");
  if (value.command === "subscribe") {
    if (!("identifier" in value)) throw new Error("subscribe identifier is required");
    const upTo = "upTo" in value ? value.upTo : undefined;
    if (upTo !== undefined && typeof upTo !== "string") throw new Error("subscribe cursor must be a string");
    return { command: "subscribe", identifier: parseCableIdentifier(value.identifier), ...(upTo === undefined ? {} : { upTo }) };
  }
  if (value.command === "unsubscribe") {
    if (!("identifier" in value)) throw new Error("unsubscribe identifier is required");
    return { command: "unsubscribe", identifier: parseCableIdentifier(value.identifier) };
  }
  if (value.command === "message") {
    if (!("identifier" in value)) throw new Error("message identifier is required");
    return { command: "message", identifier: parseCableIdentifier(value.identifier), data: "data" in value ? value.data : undefined };
  }
  if (value.command === "pong") {
    const time = "time" in value ? value.time : undefined;
    if (time !== undefined && typeof time !== "number") throw new Error("pong time must be a number");
    return { command: "pong", ...(time === undefined ? {} : { time }) };
  }
  throw new Error("unknown cable command");
}

export function serializeCableIdentifier(identifier: CableIdentifier): string {
  switch (identifier.channel) {
    case "shell": return JSON.stringify(["shell"]);
    case "update": return JSON.stringify(["update"]);
    case "workspace": return JSON.stringify(["workspace", identifier.workspaceId]);
    case "agent": return JSON.stringify(["agent", identifier.workspaceId, identifier.label]);
  }
}
