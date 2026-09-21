import { createAtelierEventBus } from "@atelier/core";
import { CableTopics, decodeCableServerMessage, serializeCableIdentifier, type CableChannelAdapter, type CableServerMessage } from "@atelier/shared";
import { expect, test } from "bun:test";
import { createCableServer } from "../src/server/cable.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";

function socket() {
  const sent: CableServerMessage[] = [];
  return { sent, send(raw: string) { sent.push(decodeCableServerMessage(raw)); return raw.length; } };
}
function server(channels: CableChannelAdapter[] = []) {
  return createCableServer({ registry: createWorkspaceRegistry(), events: createAtelierEventBus(), channels, logError: () => {} });
}
const identifier = CableTopics.agent("workspace", "conversation");

test("topic identity is canonical and rejects empty scope", () => {
  expect(() => CableTopics.agent("", "conversation")).toThrow();
  expect(serializeCableIdentifier(CableTopics.module("tree", "w", { a: "1", b: "2" }))).toBe(serializeCableIdentifier(CableTopics.module("tree", "w", { b: "2", a: "1" })));
});

test("one subscription confirms first, delivers later messages, and releases once", async () => {
  let publish!: (value: string) => void;
  let releases = 0;
  const cable = server([{ name: "agent", subscribe(_identifier, listener) {
    publish = listener;
    listener("initial");
    return { ready: Promise.resolve(), unsubscribe() { releases++; } };
  } }]);
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "mount" }));
  await Bun.sleep(0);
  publish("changed");
  expect(ws.sent.map(message => message.type)).toEqual(["welcome", "confirm_subscription", "turbo_stream"]);
  cable.message(ws, JSON.stringify({ command: "unsubscribe", identifier, subscriptionId: "mount" }));
  publish("obsolete");
  cable.close(ws);
  expect(ws.sent).toHaveLength(3);
  expect(releases).toBe(1);
});

test("late async initialization cannot attach to a superseded mount", async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  let releases = 0;
  const cable = server([{ name: "agent", async subscribe(_identifier, listener) {
    if (++calls === 1) await gate.promise;
    listener("current");
    return { ready: Promise.resolve(), unsubscribe() { releases++; } };
  } }]);
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  for (const subscriptionId of ["old", "new"]) cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId }));
  await Bun.sleep(0);
  gate.resolve();
  await Bun.sleep(0);
  expect(ws.sent.filter(message => message.type === "confirm_subscription").map(message => message.subscriptionId)).toEqual(["new"]);
  expect(releases).toBe(1);
  cable.message(ws, JSON.stringify({ command: "unsubscribe", identifier, subscriptionId: "old" }));
  expect(releases).toBe(1);
  cable.close(ws);
  expect(releases).toBe(2);
});

test("closing during initialization releases the late upstream", async () => {
  const gate = Promise.withResolvers<void>();
  let releases = 0;
  const cable = server([{ name: "agent", async subscribe(_identifier, listener) {
    await gate.promise;
    listener("late");
    return { ready: Promise.resolve(), unsubscribe() { releases++; } };
  } }]);
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "mount" }));
  cable.close(ws);
  gate.resolve();
  await Bun.sleep(0);
  expect(ws.sent).toHaveLength(1);
  expect(releases).toBe(1);
});

test("invalid messages and unavailable channels fail explicitly", async () => {
  const cable = server();
  const ws = socket();
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  cable.message(ws, "not json");
  expect(ws.sent.at(-1)?.type).toBe("error");
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "mount" }));
  await Bun.sleep(0);
  expect(ws.sent.at(-1)?.type).toBe("reject_subscription");
  expect(cable.stats().subscriptions).toEqual({});
  cable.close(ws);
});

test("slow sockets are disconnected rather than accumulating event history", () => {
  const cable = server();
  let closed = false;
  const ws = { send() { throw new Error("must not enqueue"); }, getBufferedAmount() { return 2 * 1024 * 1024; }, close() { closed = true; } };
  cable.open(ws, { kind: "cable", connectionId: "connection" });
  expect(closed).toBe(true);
  cable.close(ws);
});
