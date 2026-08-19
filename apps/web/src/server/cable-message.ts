import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { CableClientMessage } from "@atelier/shared";

const cableIdentifierSchema = Type.Union([
  Type.Object({ channel: Type.Literal("shell") }),
  Type.Object({ channel: Type.Literal("update") }),
  Type.Object({ channel: Type.Literal("workspace"), workspaceId: Type.String({ minLength: 1 }) }),
  Type.Object({ channel: Type.Literal("agent"), workspaceId: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1 }) }),
]);

const cableClientMessageSchema = Type.Union([
  Type.Object({ command: Type.Literal("subscribe"), identifier: cableIdentifierSchema, upTo: Type.Optional(Type.String()) }),
  Type.Object({ command: Type.Literal("unsubscribe"), identifier: cableIdentifierSchema }),
  Type.Object({ command: Type.Literal("pong"), time: Type.Optional(Type.Number()) }),
]);

type DecodedCableClientMessage = Static<typeof cableClientMessageSchema>;

export function decodeCableClientMessage(text: string): CableClientMessage {
  let encoded: unknown;
  try {
    encoded = JSON.parse(text);
  } catch {
    throw new Error("cable message must be valid JSON");
  }

  try {
    const decoded: DecodedCableClientMessage = Value.Parse(cableClientMessageSchema, Value.Clean(cableClientMessageSchema, encoded));
    return decoded;
  } catch {
    throw new Error("unsupported cable message");
  }
}
