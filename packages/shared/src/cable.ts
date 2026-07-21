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

export function parseCableIdentifier(value: unknown): CableIdentifier {
  if (!value || typeof value !== "object") throw new Error("identifier must be an object");
  const record = value as Record<string, unknown>;
  if (record.channel === "shell") return { channel: "shell" };
  if (record.channel === "update") return { channel: "update" };
  if (record.channel === "workspace" && typeof record.workspaceId === "string" && record.workspaceId.length > 0) return { channel: "workspace", workspaceId: record.workspaceId };
  if (record.channel === "agent" && typeof record.workspaceId === "string" && record.workspaceId.length > 0 && typeof record.label === "string" && record.label.length > 0) return { channel: "agent", workspaceId: record.workspaceId, label: record.label };
  throw new Error("unsupported cable identifier");
}

export function serializeCableIdentifier(identifier: CableIdentifier): string {
  const parsed = parseCableIdentifier(identifier);
  switch (parsed.channel) {
    case "shell": return JSON.stringify(["shell"]);
    case "update": return JSON.stringify(["update"]);
    case "workspace": return JSON.stringify(["workspace", parsed.workspaceId]);
    case "agent": return JSON.stringify(["agent", parsed.workspaceId, parsed.label]);
  }
}
