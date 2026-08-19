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
  connected(): boolean;
}

function requireNonEmpty(value: string, message: string): string {
  if (!(value.length > 0)) throw new Error(message);
  return value;
}

export const CableTopics = {
  shell(): CableIdentifier { return { channel: "shell" }; },
  update(): CableIdentifier { return { channel: "update" }; },
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
    case "update": return JSON.stringify(["update"]);
    case "workspace": return JSON.stringify(["workspace", requireNonEmpty(identifier.workspaceId, "workspace identifier must not be empty")]);
    case "agent": return JSON.stringify([
      "agent",
      requireNonEmpty(identifier.workspaceId, "workspace identifier must not be empty"),
      requireNonEmpty(identifier.label, "agent label must not be empty"),
    ]);
    default: throw new Error("unsupported cable identifier");
  }
}
