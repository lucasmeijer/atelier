import { describe, expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import { CableTopics, decodeCableServerMessage, serializeCableIdentifier, type CableClientMessage, type CableServerMessage } from "@atelier/shared";
import { createCableServer, type CableSocketData } from "../src/server/cable.ts";
import { createAtelierCableClient } from "../src/client/cable.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";

function fakeSocket(data: CableSocketData) {
  const sent: CableServerMessage[] = [];
  return {
    data,
    sent,
    send(value: string) { sent.push(decodeCableServerMessage(value)); return value.length; },
  };
}

interface DeferredSignal {
  promise: Promise<void>;
  resolve(): void;
}

function deferredSignal(): DeferredSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("cable topics enforce identifier invariants", () => {
  expect(() => CableTopics.workspace("")).toThrow("workspace identifier must not be empty");
  expect(() => CableTopics.agent("workspace", "")).toThrow("agent conversation identifier must not be empty");
  expect(serializeCableIdentifier(CableTopics.agent("workspace", "conversation-1"))).toBe('["agent","workspace","conversation-1"]');
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
    cable.message(ws, JSON.stringify({ command: "subscribe", subscriptionId: "subscription-1", identifier: { channel: "shell" } }));
    await Bun.sleep(0);

    expect(ws.sent).toEqual([
      { type: "welcome", connectionId: "conn-1" },
      {
        type: "confirm_subscription",
        subscriptionId: "subscription-1",
        identifier: { channel: "shell" },
        html: '<turbo-stream action="replace" target="initial"><template>ok</template></turbo-stream>',
      },
    ]);

    cable.broadcast({ channel: "shell" }, '<turbo-stream action="replace" target="x"><template>1</template></turbo-stream>');
    expect(ws.sent).toContainEqual({ type: "turbo_stream", subscriptionId: "subscription-1", identifier: { channel: "shell" }, html: '<turbo-stream action="replace" target="x"><template>1</template></turbo-stream>' });

    cable.message(ws, JSON.stringify({ command: "unsubscribe", subscriptionId: "subscription-1", identifier: { channel: "shell" } }));
    await Bun.sleep(0);
    cable.broadcast({ channel: "shell" }, '<turbo-stream action="replace" target="x"><template>2</template></turbo-stream>');
    expect(ws.sent).not.toContainEqual({ type: "turbo_stream", subscriptionId: "subscription-1", identifier: { channel: "shell" }, html: '<turbo-stream action="replace" target="x"><template>2</template></turbo-stream>' });

    cable.message(ws, JSON.stringify({ command: "subscribe", subscriptionId: "subscription-1", identifier: { channel: "shell" } }));
    await Bun.sleep(0);
    cable.close(ws);
    expect(cable.stats().sockets).toBe(0);
    expect(cable.stats().subscriptions).toEqual({});
  });

  test("an obsolete slow subscription does not block unsubscribe or a newer subscription", async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    await registry.seed([{ id: "workspace-b", title: "Workspace B" }]);
    const snapshotStarted = deferredSignal();
    const releaseSnapshot = deferredSignal();
    const cable = createCableServer({
      registry,
      events: createAtelierEventBus(),
      async shellSnapshot() {
        snapshotStarted.resolve();
        await releaseSnapshot.promise;
        return '<turbo-stream action="update" target="shell"><template>snapshot</template></turbo-stream>';
      },
    });
    const ws = fakeSocket({ kind: "cable", connectionId: "ordered" });
    cable.open(ws, ws.data);

    cable.message(ws, JSON.stringify({ command: "subscribe", subscriptionId: "subscription-1", identifier: { channel: "shell" } }));
    await snapshotStarted.promise;
    cable.message(ws, JSON.stringify({ command: "unsubscribe", subscriptionId: "subscription-1", identifier: { channel: "shell" } }));
    cable.message(ws, JSON.stringify({ command: "subscribe", subscriptionId: "subscription-1", identifier: { channel: "workspace", workspaceId: "workspace-b" } }));

    expect(cable.stats().subscriptions).toEqual({ '["workspace","workspace-b"]': 1 });
    expect(ws.sent).toEqual([
      { type: "welcome", connectionId: "ordered" },
      { type: "confirm_subscription", subscriptionId: "subscription-1", identifier: { channel: "workspace", workspaceId: "workspace-b" } },
    ]);

    releaseSnapshot.resolve();
    await Bun.sleep(0);

    expect(ws.sent).toEqual([
      { type: "welcome", connectionId: "ordered" },
      { type: "confirm_subscription", subscriptionId: "subscription-1", identifier: { channel: "workspace", workspaceId: "workspace-b" } },
    ]);
  });

  test("subscribe-unsubscribe-subscribe uses attempt identity for the same topic", async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const firstSnapshotStarted = deferredSignal();
    const rejectFirstSnapshot = deferredSignal();
    let snapshots = 0;
    const errors: string[] = [];
    const cable = createCableServer({
      registry,
      events: createAtelierEventBus(),
      logError: (message) => errors.push(message),
      async shellSnapshot() {
        snapshots += 1;
        if (snapshots === 1) {
          firstSnapshotStarted.resolve();
          await rejectFirstSnapshot.promise;
          throw new Error("obsolete snapshot failed");
        }
        return '<turbo-stream action="update" target="shell"><template>fresh</template></turbo-stream>';
      },
    });
    const ws = fakeSocket({ kind: "cable", connectionId: "same-key" });
    cable.open(ws, ws.data);

    cable.message(ws, JSON.stringify({ command: "subscribe", subscriptionId: "old", identifier: { channel: "shell" } }));
    await firstSnapshotStarted.promise;
    cable.message(ws, JSON.stringify({ command: "unsubscribe", subscriptionId: "old", identifier: { channel: "shell" } }));
    cable.message(ws, JSON.stringify({ command: "subscribe", subscriptionId: "current", identifier: { channel: "shell" } }));
    await Bun.sleep(0);

    expect(ws.sent).toEqual([
      { type: "welcome", connectionId: "same-key" },
      {
        type: "confirm_subscription",
        subscriptionId: "current",
        identifier: { channel: "shell" },
        html: '<turbo-stream action="update" target="shell"><template>fresh</template></turbo-stream>',
      },
    ]);
    expect(cable.stats().subscriptions).toEqual({ '["shell"]': 1 });

    rejectFirstSnapshot.resolve();
    await Bun.sleep(0);

    expect(ws.sent.some((message) => message.type === "reject_subscription")).toBe(false);
    expect(cable.stats().subscriptions).toEqual({ '["shell"]': 1 });
    expect(errors).toEqual([]);
  });

  test("a newer same-topic subscribe supersedes a pending attempt without waiting", async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const firstSnapshotStarted = deferredSignal();
    const releaseFirstSnapshot = deferredSignal();
    let snapshots = 0;
    const cable = createCableServer({
      registry,
      events: createAtelierEventBus(),
      async shellSnapshot() {
        snapshots += 1;
        if (snapshots === 1) {
          firstSnapshotStarted.resolve();
          await releaseFirstSnapshot.promise;
          return "stale";
        }
        return "fresh";
      },
    });
    const ws = fakeSocket({ kind: "cable", connectionId: "same-key-newer" });
    cable.open(ws, ws.data);

    cable.message(ws, JSON.stringify({ command: "subscribe", subscriptionId: "old", identifier: { channel: "shell" } }));
    await firstSnapshotStarted.promise;
    cable.message(ws, JSON.stringify({ command: "subscribe", subscriptionId: "current", identifier: { channel: "shell" } }));
    await Bun.sleep(0);

    expect(ws.sent).toEqual([
      { type: "welcome", connectionId: "same-key-newer" },
      { type: "confirm_subscription", subscriptionId: "current", identifier: { channel: "shell" }, html: "fresh" },
    ]);

    releaseFirstSnapshot.resolve();
    await Bun.sleep(0);
    expect(ws.sent).toHaveLength(2);
  });

  test("an obsolete unsubscribe cannot release a newer same-topic generation", async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const cable = createCableServer({ registry, events: createAtelierEventBus() });
    const ws = fakeSocket({ kind: "cable", connectionId: "generation-aware" });
    const identifier = CableTopics.shell();
    cable.open(ws, ws.data);

    cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "old" }));
    cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "current" }));
    cable.message(ws, JSON.stringify({ command: "unsubscribe", identifier, subscriptionId: "old" }));
    await Bun.sleep(0);

    expect(cable.stats().subscriptions).toEqual({ '["shell"]': 1 });
    cable.broadcast(identifier, "live");
    expect(ws.sent).toContainEqual({ type: "turbo_stream", identifier, subscriptionId: "current", html: "live" });
  });

  test("buffers shell broadcasts until the authoritative snapshot is confirmed", async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const snapshotStarted = deferredSignal();
    const releaseSnapshot = deferredSignal();
    const cable = createCableServer({
      registry,
      events: createAtelierEventBus(),
      async shellSnapshot() {
        snapshotStarted.resolve();
        await releaseSnapshot.promise;
        return '<turbo-stream action="update" target="shell"><template>snapshot</template></turbo-stream>';
      },
    });
    const ws = fakeSocket({ kind: "cable", connectionId: "buffered" });
    cable.open(ws, ws.data);
    cable.message(ws, JSON.stringify({ command: "subscribe", subscriptionId: "subscription-1", identifier: { channel: "shell" } }));
    await snapshotStarted.promise;

    cable.broadcast({ channel: "shell" }, '<turbo-stream action="update" target="one"><template>1</template></turbo-stream>');
    cable.broadcast({ channel: "shell" }, '<turbo-stream action="update" target="two"><template>2</template></turbo-stream>');
    expect(ws.sent).toEqual([{ type: "welcome", connectionId: "buffered" }]);

    releaseSnapshot.resolve();
    await Bun.sleep(0);

    expect(ws.sent).toEqual([
      { type: "welcome", connectionId: "buffered" },
      {
        type: "confirm_subscription",
        subscriptionId: "subscription-1",
        identifier: { channel: "shell" },
        html: '<turbo-stream action="update" target="shell"><template>snapshot</template></turbo-stream>',
      },
      {
        type: "turbo_stream",
        subscriptionId: "subscription-1",
        identifier: { channel: "shell" },
        html: '<turbo-stream action="update" target="one"><template>1</template></turbo-stream>',
      },
      {
        type: "turbo_stream",
        subscriptionId: "subscription-1",
        identifier: { channel: "shell" },
        html: '<turbo-stream action="update" target="two"><template>2</template></turbo-stream>',
      },
    ]);
  });

  test("closing a socket cancels its pending subscription", async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const snapshotStarted = deferredSignal();
    const releaseSnapshot = deferredSignal();
    const cable = createCableServer({
      registry,
      events: createAtelierEventBus(),
      async shellSnapshot() {
        snapshotStarted.resolve();
        await releaseSnapshot.promise;
        return "obsolete";
      },
    });
    const ws = fakeSocket({ kind: "cable", connectionId: "closing" });
    cable.open(ws, ws.data);
    cable.message(ws, JSON.stringify({ command: "subscribe", subscriptionId: "subscription-1", identifier: { channel: "shell" } }));
    await snapshotStarted.promise;

    cable.close(ws);
    expect(cable.stats()).toEqual({ sockets: 0, subscriptions: {}, upstreams: {} });
    releaseSnapshot.resolve();
    await Bun.sleep(0);

    expect(ws.sent).toEqual([{ type: "welcome", connectionId: "closing" }]);
  });

  for (const cancellation of ["unsubscribe", "close"] as const) {
    test(`${cancellation} releases a pending Agent runtime subscription before its snapshot resolves`, async () => {
      const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
      const snapshotStarted = deferredSignal();
      const releaseSnapshot = deferredSignal();
      let runtimeSubscribers = 0;
      const cable = createCableServer({
        registry,
        events: createAtelierEventBus(),
        async resolveAgentRuntime(workspaceId, conversationId) {
          expect({ workspaceId, conversationId }).toEqual({ workspaceId: "agent-workspace", conversationId: "agent-conversation" });
          return {
            subscribeLivePresentation(listener) {
              runtimeSubscribers += 1;
              let active = true;
              return {
                ready: (async () => {
                  snapshotStarted.resolve();
                  await releaseSnapshot.promise;
                  if (active) listener("obsolete Agent snapshot");
                })(),
                unsubscribe() {
                  if (!active) return;
                  active = false;
                  runtimeSubscribers -= 1;
                },
              };
            },
          };
        },
      });
      const ws = fakeSocket({ kind: "cable", connectionId: `agent-${cancellation}` });
      const identifier = CableTopics.agent("agent-workspace", "agent-conversation");
      cable.open(ws, ws.data);
      cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "subscription-1" }));
      await snapshotStarted.promise;
      expect(runtimeSubscribers).toBe(1);

      if (cancellation === "unsubscribe") cable.message(ws, JSON.stringify({ command: "unsubscribe", identifier, subscriptionId: "subscription-1" }));
      else cable.close(ws);

      expect(runtimeSubscribers).toBe(0);
      expect(cable.stats()).toEqual({
        sockets: cancellation === "close" ? 0 : 1,
        subscriptions: {},
        upstreams: {},
      });
      releaseSnapshot.resolve();
      await Bun.sleep(0);
      expect(ws.sent).toEqual([{ type: "welcome", connectionId: `agent-${cancellation}` }]);
    });
  }

  test("broadcast can exclude or target one Cable connection", async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const cable = createCableServer({ registry, events: createAtelierEventBus() });
    const initiating = fakeSocket({ kind: "cable", connectionId: "origin" });
    const observer = fakeSocket({ kind: "cable", connectionId: "observer" });
    for (const socket of [initiating, observer]) {
      cable.open(socket, socket.data);
      cable.message(socket, JSON.stringify({ command: "subscribe", subscriptionId: "subscription-1", identifier: { channel: "shell" } }));
    }
    await Bun.sleep(0);
    initiating.sent.length = 0;
    observer.sent.length = 0;

    cable.broadcast(CableTopics.shell(), '<turbo-stream action="append" target="agent_bodies"></turbo-stream>', { exceptConnectionId: "origin" });

    expect(initiating.sent).toEqual([]);
    expect(observer.sent).toEqual([{
      type: "turbo_stream",
      identifier: { channel: "shell" },
      subscriptionId: "subscription-1",
      html: '<turbo-stream action="append" target="agent_bodies"></turbo-stream>',
    }]);

    initiating.sent.length = 0;
    observer.sent.length = 0;
    cable.broadcast(CableTopics.shell(), '<turbo-stream action="select-agent"></turbo-stream>', { onlyConnectionId: "origin" });

    expect(initiating.sent).toEqual([{
      type: "turbo_stream",
      identifier: { channel: "shell" },
      subscriptionId: "subscription-1",
      html: '<turbo-stream action="select-agent"></turbo-stream>',
    }]);
    expect(observer.sent).toEqual([]);
    expect(() => cable.broadcast(CableTopics.shell(), "invalid", { exceptConnectionId: "origin", onlyConnectionId: "observer" }))
      .toThrow("Cable broadcast cannot combine exceptConnectionId and onlyConnectionId");
  });

  test("rejects unauthorized workspace subscriptions", async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const cable = createCableServer({ registry, events: createAtelierEventBus() });
    const ws = fakeSocket({ kind: "cable", connectionId: "conn-1" });
    cable.open(ws, ws.data);
    cable.message(ws, JSON.stringify({ command: "subscribe", subscriptionId: "subscription-1", identifier: { channel: "workspace", workspaceId: "missing" } }));
    await Bun.sleep(0);
    expect(ws.sent).toContainEqual({ type: "reject_subscription", subscriptionId: "subscription-1", identifier: { channel: "workspace", workspaceId: "missing" }, reason: "workspace not found: missing" });
  });

  test("routes Agent updates exclusively through the snapshot-first runtime subscription", () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const cable = createCableServer({ registry, events: createAtelierEventBus() });
    expect(() => cable.broadcast(CableTopics.agent("workspace", "conversation-1"), "<turbo-stream></turbo-stream>"))
      .toThrow("Agent updates must be published through the runtime live-presentation interface");
  });

  for (const [name, raw, reason] of [
    ["subscriptions without an ID", JSON.stringify({ command: "subscribe", identifier: { channel: "shell" } }), "unsupported cable message"],
    ["unsubscriptions without an ID", JSON.stringify({ command: "unsubscribe", identifier: { channel: "shell" } }), "unsupported cable message"],
    ["empty workspace identifiers", JSON.stringify({ command: "subscribe", subscriptionId: "subscription-1", identifier: { channel: "workspace", workspaceId: "" } }), "unsupported cable message"],
    ["missing Agent conversation identifiers", JSON.stringify({ command: "subscribe", subscriptionId: "subscription-1", identifier: { channel: "agent", workspaceId: "workspace", label: "Agent 1" } }), "unsupported cable message"],
    ["unknown commands", JSON.stringify({ command: "mystery", identifier: { channel: "shell" } }), "unsupported cable message"],
    ["unsupported channel messages", JSON.stringify({ command: "message", identifier: { channel: "shell" }, data: { event: "run" } }), "unsupported cable message"],
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

    cable.message(ws, JSON.stringify({ command: "subscribe", subscriptionId: "subscription-1", identifier: { channel: "shell", extra: true }, extra: true }));
    await Bun.sleep(0);

    expect(ws.sent).toContainEqual({ type: "confirm_subscription", subscriptionId: "subscription-1", identifier: { channel: "shell" } });
  });
});

test("cable leases share topics and reject stale generations across reconnects", async () => {
  type SocketHandler = ((event: { data: string }) => void) | null;
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static readonly instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.CONNECTING;
    onmessage: SocketHandler = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readonly sent: CableClientMessage[] = [];

    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
    }

    send(value: string): void {
      this.sent.push(JSON.parse(value));
    }

    open(connectionId: string): void {
      this.readyState = FakeWebSocket.OPEN;
      this.receive({ type: "welcome", connectionId });
    }

    receive(message: CableServerMessage): void {
      this.onmessage?.({ data: JSON.stringify(message) });
    }

    close(): void {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  const names = ["window", "location", "WebSocket", "requestAnimationFrame"] as const;
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const events: string[] = [];
  const testWindow = Object.assign(new EventTarget(), {
    Turbo: { renderStreamMessage: (html: string) => events.push(`render:${html}`) },
  });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: testWindow },
    location: { configurable: true, value: { protocol: "http:", host: "atelier.test" } },
    WebSocket: { configurable: true, value: FakeWebSocket },
    requestAnimationFrame: { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } },
  });

  try {
    const identifier = CableTopics.agent("workspace", "conversation-1");
    const cable = createAtelierCableClient();
    const firstLease = cable.subscribe(identifier, {
      onReady: () => events.push("ready:first"),
      onDisconnected: () => events.push("disconnected:first"),
    });
    const secondLease = cable.subscribe(identifier, {
      onReady: () => events.push("ready:second"),
      onDisconnected: () => events.push("disconnected:second"),
    });

    const first = FakeWebSocket.instances[0]!;
    expect(first.url).toBe("ws://atelier.test/cable");
    first.open("connection-1");
    const firstMessage = first.sent[0]!;
    if (firstMessage.command !== "subscribe") throw new Error("expected first Cable message to subscribe");
    const firstSubscriptionId = firstMessage.subscriptionId;
    expect(first.sent).toEqual([{ command: "subscribe", identifier, subscriptionId: firstSubscriptionId }]);
    first.receive({ type: "confirm_subscription", identifier, subscriptionId: firstSubscriptionId, html: "snapshot-1" });
    expect(events).toEqual(["render:snapshot-1", "ready:first", "ready:second"]);

    firstLease.unsubscribe();
    expect(first.sent).toHaveLength(1);
    first.receive({ type: "turbo_stream", identifier, subscriptionId: firstSubscriptionId, html: "live-1" });
    expect(events).toEqual(["render:snapshot-1", "ready:first", "ready:second", "render:live-1"]);

    first.close();
    expect(events).toEqual(["render:snapshot-1", "ready:first", "ready:second", "render:live-1", "disconnected:second"]);
    await Bun.sleep(120);

    const second = FakeWebSocket.instances[1]!;
    second.open("connection-2");
    const secondMessage = second.sent[0]!;
    if (secondMessage.command !== "subscribe") throw new Error("expected second Cable message to subscribe");
    const secondSubscriptionId = secondMessage.subscriptionId;
    expect(secondSubscriptionId).not.toBe(firstSubscriptionId);
    expect(second.sent).toEqual([{ command: "subscribe", identifier, subscriptionId: secondSubscriptionId }]);
    second.receive({ type: "confirm_subscription", identifier, subscriptionId: firstSubscriptionId, html: "stale-snapshot" });
    second.receive({ type: "turbo_stream", identifier, subscriptionId: firstSubscriptionId, html: "stale-stream" });
    expect(events).toEqual(["render:snapshot-1", "ready:first", "ready:second", "render:live-1", "disconnected:second"]);
    second.receive({ type: "confirm_subscription", identifier, subscriptionId: secondSubscriptionId, html: "snapshot-2" });
    expect(events).toEqual(["render:snapshot-1", "ready:first", "ready:second", "render:live-1", "disconnected:second", "render:snapshot-2", "ready:second"]);
    secondLease.unsubscribe();
    expect(second.sent).toEqual([
      { command: "subscribe", identifier, subscriptionId: secondSubscriptionId },
      { command: "unsubscribe", identifier, subscriptionId: secondSubscriptionId },
    ]);
    testWindow.dispatchEvent(new Event("pagehide"));
  } finally {
    for (const name of names) {
      const descriptor = originals.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
