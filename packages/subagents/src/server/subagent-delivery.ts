import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { messageEnvelope } from "./subagent-protocol.ts";
import { unreadMessageCount, type SubagentMessage, type SubagentState } from "./subagent-runtime.ts";

export const subagentDeliveryType = "subagent_model_delivery";
const persistedDeliverySchema = Type.Object({
  turnEntryId: Type.String(),
  duringActivity: Type.Boolean(),
  format: Type.Optional(Type.Union([Type.Literal("agent_message"), Type.Literal("user")])),
  remaining: Type.Integer({ minimum: 0 }),
  messages: Type.Array(Type.Object({ id: Type.String(), recipient: Type.Optional(Type.String()), immediate: Type.Optional(Type.Boolean()), envelope: Type.String() })),
});
type PersistedDelivery = Static<typeof persistedDeliverySchema>;
export type SubagentDelivery = Omit<PersistedDelivery, "messages"> & { messages: Array<PersistedDelivery["messages"][number] & { recipient: string }> };

/** Persisted session metadata is an external input, and is never added to model context. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Persisted session metadata is parsed at this I/O boundary.
export function parseSubagentDelivery(data: unknown, messages: SubagentMessage[] = []): SubagentDelivery {
  const batch = Value.Parse(persistedDeliverySchema, data);
  return { ...batch, messages: batch.messages.map((message) => {
    const recipient = message.recipient ?? messages.find((record) => record.id === message.id)?.to;
    if (!recipient) throw new Error(`Missing recipient for persisted delivery: ${message.id}`);
    return { ...message, recipient };
  }) };
}

/** Only first inclusion counts as draining the queue; ordinary history replay does not. */
export function modelDeliveryBatch(state: SubagentState, recipient: string, included: SubagentMessage[], previous: SubagentDelivery[], turnEntryId: string, duringActivity: boolean, format: "agent_message" | "user" = "agent_message"): SubagentDelivery | undefined {
  const delivered = new Set(previous.flatMap((batch) => batch.messages.map((message) => message.id)));
  const messages = included.filter((message) => message.to === recipient && !delivered.has(message.id));
  if (!messages.length) return undefined;
  for (const message of messages) delivered.add(message.id);
  return {
    turnEntryId, duringActivity, format,
    remaining: unreadMessageCount(state, recipient, delivered),
    messages: messages.map((message) => ({ id: message.id, recipient: message.to, immediate: message.dispatchMode === "immediate", envelope: messageEnvelope(state, message) })),
  };
}

/** Immediate receipts carry their own envelope; only delayed messages need a separate queue-drain entry. */
export function queuedModelDelivery(batch: SubagentDelivery): SubagentDelivery | undefined {
  const messages = batch.messages.filter((message) => !message.immediate);
  return messages.length ? { ...batch, messages } : undefined;
}
