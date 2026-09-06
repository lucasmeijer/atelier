import { expect, test } from "bun:test";
import { modelDeliveryBatch, parseSubagentDelivery, queuedModelDelivery } from "../../src/server/subagent-delivery.ts";
import type { SubagentMessage, SubagentState } from "../../src/server/subagent-runtime.ts";

const message = (id: string, to = "root"): SubagentMessage => ({ id, from: "child", to, kind: "message", text: `Update ${id}`, timestamp: new Date(0).toISOString(), delivery: "delivered" });
const state = (messages: SubagentMessage[]): SubagentState => ({ agents: [{ id: "child", parentId: "root", rootId: "root", taskName: "review", task: "Review", depth: 1, status: "completed", thinkingLevel: "off" }], messages });

test("one request drains three messages and preserves their actual plaintext envelopes", () => {
  const messages = [message("1"), message("2"), message("3")];
  const batch = modelDeliveryBatch(state(messages), "root", messages, [], "user-entry", false)!;
  expect(batch.messages.map((message) => message.id)).toEqual(["1", "2", "3"]);
  expect(batch.remaining).toBe(0);
  expect(batch.duringActivity).toBe(false);
  expect(batch.messages[0].envelope).toContain("Update 1");
  expect(batch.messages[0].envelope).toContain("/root/review");
  expect(parseSubagentDelivery(JSON.parse(JSON.stringify(batch)))).toEqual(batch);
});

test("history replay and retries do not redeliver previously recorded messages", () => {
  const messages = [message("1"), message("2")];
  const first = modelDeliveryBatch(state(messages), "root", [messages[0]], [], "user-entry", false)!;
  expect(first.remaining).toBe(1);
  expect(modelDeliveryBatch(state(messages), "root", [messages[0]], [first], "user-entry", true)).toBeUndefined();
  const next = modelDeliveryBatch(state(messages), "root", messages, [first], "user-entry", true)!;
  expect(next.messages.map((message) => message.id)).toEqual(["2"]);
  expect(next.duringActivity).toBe(true);
  expect(next.remaining).toBe(0);
});

test("queue snapshot excludes failed and other recipients' messages, but includes not-yet-in-context traffic", () => {
  const messages = [message("1"), { ...message("2"), delivery: "queued" as const }, { ...message("3"), delivery: "failed" as const }, message("4", "other")];
  const batch = modelDeliveryBatch(state(messages), "root", [messages[0]], [], "turn", false)!;
  expect(batch.remaining).toBe(1);
  expect(modelDeliveryBatch(state(messages), "other", [messages[0]], [], "turn", false)).toBeUndefined();
});

test("invalid persisted delivery metadata fails visibly", () => {
  expect(() => parseSubagentDelivery({ messages: [] })).toThrow();
});


test("immediate delivery is recorded for deduplication but does not drain the deferred queue", () => {
  const messages = [{ ...message("immediate"), dispatchMode: "immediate" as const }, { ...message("delayed"), dispatchMode: "queued" as const }];
  const batch = modelDeliveryBatch(state(messages), "root", messages, [], "turn", false, "user")!;
  expect(batch.format).toBe("user");
  expect(batch.messages.map((message) => message.immediate)).toEqual([true, false]);
  expect(queuedModelDelivery(batch)!.messages.map((message) => message.id)).toEqual(["delayed"]);
  expect(modelDeliveryBatch(state(messages), "root", messages, [batch], "turn", true, "user")).toBeUndefined();
  const immediateOnly = modelDeliveryBatch(state(messages), "root", [messages[0]], [], "turn", false)!;
  expect(queuedModelDelivery(immediateOnly)).toBeUndefined();
  expect(immediateOnly.remaining).toBe(1);
});

test("older delivery metadata retains separate receipt and queue events", () => {
  const old = parseSubagentDelivery({ turnEntryId: "turn", duringActivity: false, remaining: 0, messages: [{ id: "old", recipient: "root", envelope: "Old envelope" }] });
  expect(queuedModelDelivery(old)!.messages).toHaveLength(1);
});

test("older delivery records recover their recipient from the durable routing ledger", () => {
  const legacy = { turnEntryId: "turn", duringActivity: false, remaining: 0, messages: [{ id: "old", envelope: "Old envelope" }] };
  expect(parseSubagentDelivery(legacy, [{ id: "old", from: "child", to: "root", kind: "completion", text: "Done", timestamp: "2026-09-05T00:00:00Z", delivery: "delivered" }]).messages[0]!.recipient).toBe("root");
  expect(() => parseSubagentDelivery(legacy)).toThrow("Missing recipient");
});
