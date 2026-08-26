import { describe, expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import { CableTopics, decodeCableServerMessage, serializeCableIdentifier } from "@atelier/shared";
import { createCableServer, type CableSocketData } from "../src/server/cable.ts";
import { cableCursorIsNewer } from "../src/client/cable.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";

function fakeSocket(data: CableSocketData) {
  const sent: unknown[] = [];
  return {
    data,
    sent,
    send(value: string) { sent.push(JSON.parse(value)); return value.length; },
  };
}

test("cable cursors reject stale revisions from the same runtime", () => {
  expect(cableCursorIsNewer(undefined, "runtime:1")).toBe(true);
  expect(cableCursorIsNewer("runtime:4", "runtime:5")).toBe(true);
  expect(cableCursorIsNewer("runtime:4", "runtime:4")).toBe(false);
  expect(cableCursorIsNewer("runtime:4", "runtime:3")).toBe(false);
  expect(cableCursorIsNewer("old-runtime:12", "new-runtime:1")).toBe(true);
});

test("cable topics enforce identifier invariants", () => {
  expect(() => CableTopics.workspace("")).toThrow("workspace identifier must not be empty");
  expect(() => CableTopics.agent("workspace", "")).toThrow("agent label must not be empty");
  expect(() => serializeCableIdentifier({ channel: "workspace", workspaceId: "" })).toThrow("workspace identifier must not be empty");
  // SAFETY: This invalid discriminant deliberately exercises the serializer's runtime guard.
  expect(() => serializeCableIdentifier({ channel: "bogus" } as never)).toThrow("unsupported cable identifier");
});

test("cable server messages are validated at the client boundary", () => {
  expect(decodeCableServerMessage(JSON.stringify({ type: "ping", time: 42 }))).toEqual({ type: "ping", time: 42 });
  expect(() => decodeCableServerMessage(JSON.stringify({ type: "ping", time: "now" }))).toThrow("unsupported cable server message");
  expect(() => decodeCableServerMessage("not JSON")).toThrow("cable server message must be valid JSON");
});

describe("cable server", () => {
  test("validates /cable upgrades", () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const cable = createCableServer({ registry, events: createAtelierEventBus() });
    expect(cable.validate(new Request("http://test/cable"), new URL("http://test/cable"))?.kind).toBe("cable");
    expect(cable.validate(new Request("http://test/nope"), new URL("http://test/nope"))).toBeUndefined();
  });

  test("subscribes, broadcasts, unsubscribes, and cleans up on close", async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const cable = createCableServer({ registry, events: createAtelierEventBus(), shellSnapshot: () => '<turbo-stream action="replace" target="initial"><template>ok</template></turbo-stream>' });
    const ws = fakeSocket({ kind: "cable", connectionId: "conn-1" });

    cable.open(ws, ws.data);
    cable.message(ws, JSON.stringify({ command: "subscribe", identifier: { channel: "shell" } }));
    await Bun.sleep(0);

    expect(ws.sent).toEqual([
      { type: "welcome", connectionId: "conn-1" },
      {
        type: "confirm_subscription",
        identifier: { channel: "shell" },
        html: '<turbo-stream action="replace" target="initial"><template>ok</template></turbo-stream>',
      },
    ]);

    cable.broadcast({ channel: "shell" }, '<turbo-stream action="replace" target="x"><template>1</template></turbo-stream>');
    expect(ws.sent).toContainEqual({ type: "turbo_stream", identifier: { channel: "shell" }, html: '<turbo-stream action="replace" target="x"><template>1</template></turbo-stream>' });

    cable.message(ws, JSON.stringify({ command: "unsubscribe", identifier: { channel: "shell" } }));
    cable.broadcast({ channel: "shell" }, '<turbo-stream action="replace" target="x"><template>2</template></turbo-stream>');
    expect(ws.sent).not.toContainEqual({ type: "turbo_stream", identifier: { channel: "shell" }, html: '<turbo-stream action="replace" target="x"><template>2</template></turbo-stream>' });

    cable.message(ws, JSON.stringify({ command: "subscribe", identifier: { channel: "shell" } }));
    await Bun.sleep(0);
    cable.close(ws);
    expect(cable.stats().sockets).toBe(0);
    expect(cable.stats().subscriptions).toEqual({});
  });

  test("rejects unauthorized workspace subscriptions", async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const cable = createCableServer({ registry, events: createAtelierEventBus() });
    const ws = fakeSocket({ kind: "cable", connectionId: "conn-1" });
    cable.open(ws, ws.data);
    cable.message(ws, JSON.stringify({ command: "subscribe", identifier: { channel: "workspace", workspaceId: "missing" } }));
    await Bun.sleep(0);
    expect(ws.sent).toContainEqual({ type: "reject_subscription", identifier: { channel: "workspace", workspaceId: "missing" }, reason: "workspace not found: missing" });
  });

  for (const [name, raw, reason] of [
    ["empty workspace identifiers", JSON.stringify({ command: "subscribe", identifier: { channel: "workspace", workspaceId: "" } }), "unsupported cable message"],
    ["unknown commands", JSON.stringify({ command: "mystery", identifier: { channel: "shell" } }), "unsupported cable message"],
    ["unsupported channel messages", JSON.stringify({ command: "message", identifier: { channel: "shell" }, data: { event: "run" } }), "unsupported cable message"],
    ["invalid subscription cursors", JSON.stringify({ command: "subscribe", identifier: { channel: "shell" }, upTo: 42 }), "unsupported cable message"],
    ["invalid pong timestamps", JSON.stringify({ command: "pong", time: "now" }), "unsupported cable message"],
    ["malformed JSON", "not JSON", "cable message must be valid JSON"],
  ]) {
    test(`rejects ${name}`, async () => {
      const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
      const cable = createCableServer({ registry, events: createAtelierEventBus() });
      const ws = fakeSocket({ kind: "cable", connectionId: "conn-1" });
      cable.open(ws, ws.data);

      cable.message(ws, raw);
      await Bun.sleep(0);

      expect(ws.sent).toEqual([
        { type: "welcome", connectionId: "conn-1" },
        { type: "error", message: reason },
      ]);
      expect(cable.stats().subscriptions).toEqual({});
    });
  }

  test("strips unrecognized message and identifier properties", async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const cable = createCableServer({ registry, events: createAtelierEventBus() });
    const ws = fakeSocket({ kind: "cable", connectionId: "conn-1" });
    cable.open(ws, ws.data);

    cable.message(ws, JSON.stringify({ command: "subscribe", identifier: { channel: "shell", extra: true }, extra: true }));
    await Bun.sleep(0);

    expect(ws.sent).toContainEqual({ type: "confirm_subscription", identifier: { channel: "shell" } });
  });
});
