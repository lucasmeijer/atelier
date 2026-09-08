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
        channels: [{ name: "agent", subscribe(identifier, listener) {
          expect(identifier).toEqual({ channel: "agent", workspaceId: "agent-workspace", conversationId: "agent-conversation" });
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
        } }],
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
      .toThrow("Channel updates must be published through the live-presentation interface");
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

  const names = ["window", "location", "WebSocket"] as const;
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const events: string[] = [];
  const testWindow = new EventTarget();
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: testWindow },
    location: { configurable: true, value: { protocol: "http:", host: "atelier.test" } },
    WebSocket: { configurable: true, value: FakeWebSocket },
  });

  try {
    const identifier = CableTopics.agent("workspace", "conversation-1");
    let deferApplication = false;
    const pendingApplications: (() => void)[] = [];
    const cable = createAtelierCableClient((html, isCurrent, onApplied) => {
      const apply = () => {
        if (!isCurrent()) return;
        events.push(`render:${html}`);
        onApplied();
      };
      if (deferApplication) pendingApplications.push(apply);
      else apply();
    });
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
    // The transport consumer may apply a received payload asynchronously. Generation
    // validity must survive that boundary, not just the receive callback.
    deferApplication = true;
    const turnIdentifier = CableTopics.agentTurn("workspace", "conversation-1", "turn", "branch");
    const obsoleteTurn = cable.subscribe(turnIdentifier, { onReady: () => events.push("ready:obsolete-turn") });
    const obsoleteAttempt = second.sent.at(-1)!;
    if (obsoleteAttempt.command !== "subscribe") throw new Error("expected turn subscription");
    const beforeDeferred = [...events];
    second.receive({ type: "confirm_subscription", identifier: turnIdentifier, subscriptionId: obsoleteAttempt.subscriptionId, html: "deferred-obsolete-snapshot" });
    expect(events).toEqual(beforeDeferred);
    expect(pendingApplications).toHaveLength(1);
    obsoleteTurn.unsubscribe();
    const currentTurn = cable.subscribe(turnIdentifier, { onReady: () => events.push("ready:current-turn") });
    const currentAttempt = second.sent.at(-1)!;
    if (currentAttempt.command !== "subscribe") throw new Error("expected reopened turn subscription");
    pendingApplications.shift()!();
    expect(events).toEqual(beforeDeferred);
    second.receive({ type: "confirm_subscription", identifier: turnIdentifier, subscriptionId: currentAttempt.subscriptionId, html: "deferred-current-snapshot" });
    expect(events).toEqual(beforeDeferred);
    pendingApplications.shift()!();
    expect(events).toEqual([...beforeDeferred, "render:deferred-current-snapshot", "ready:current-turn"]);
    second.receive({ type: "turbo_stream", identifier: turnIdentifier, subscriptionId: currentAttempt.subscriptionId, html: "deferred-obsolete-increment" });
    const beforeCancelledIncrement = [...events];
    currentTurn.unsubscribe();
    pendingApplications.shift()!();
    expect(events).toEqual(beforeCancelledIncrement);
    testWindow.dispatchEvent(new Event("pagehide"));
  } finally {
    for (const name of names) {
      const descriptor = originals.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});


test("module tree Cable topic has a distinct root-scoped identity", () => {
  expect(serializeCableIdentifier(CableTopics.module("tree", "workspace", { conversationId: "root" }))).toBe('["module","tree","workspace",[["conversationId","root"]]]');
  expect(() => CableTopics.module("", "workspace")).toThrow("channel name must not be empty");
});

test("module tree subscriptions deliver a snapshot then changes and release their upstream", async () => {
  const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
  await registry.seed([{ id: "workspace", title: "Workspace" }]);
  let publish!: (value: string) => void;
  let released = 0;
  const cable = createCableServer({
    registry, events: createAtelierEventBus(),
    channels: [{ name: "tree", async subscribe(identifier, listener) {
      expect(identifier).toEqual(CableTopics.module("tree", "workspace", { conversationId: "root" }));
      publish = listener;
      listener("snapshot-payload");
      return { ready: Promise.resolve(), unsubscribe() { released++; } };
    } }],
  });
  const ws = fakeSocket({ kind: "cable", connectionId: "tree" });
  cable.open(ws, ws.data);
  const identifier = CableTopics.module("tree", "workspace", { conversationId: "root" });
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "tree-1" }));
  await Bun.sleep(0);
  expect(ws.sent.at(-1)).toEqual({ type: "confirm_subscription", identifier, subscriptionId: "tree-1", html: "snapshot-payload" });
  publish("change-payload");
  expect(ws.sent.at(-1)).toEqual({ type: "turbo_stream", identifier, subscriptionId: "tree-1", html: "change-payload" });
  cable.message(ws, JSON.stringify({ command: "unsubscribe", identifier, subscriptionId: "tree-1" }));
  const count = ws.sent.length;
  publish("obsolete-payload");
  expect(ws.sent.length).toBe(count);
  expect(released).toBe(1);
  expect(cable.stats().upstreams).toEqual({});
  cable.close(ws);
});

test("closing during module subscription setup releases the late upstream", async () => {
  const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
  await registry.seed([{ id: "workspace", title: "Workspace" }]);
  const setup = deferredSignal();
  let released = 0;
  const cable = createCableServer({
    registry, events: createAtelierEventBus(),
    channels: [{ name: "tree", async subscribe(_identifier, listener) {
      await setup.promise;
      listener("late-snapshot");
      return { ready: Promise.resolve(), unsubscribe() { released++; } };
    } }],
  });
  const ws = fakeSocket({ kind: "cable", connectionId: "late-tree" });
  cable.open(ws, ws.data);
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier: CableTopics.module("tree", "workspace", { conversationId: "root" }), subscriptionId: "tree-1" }));
  cable.close(ws);
  const count = ws.sent.length;
  setup.resolve();
  await Bun.sleep(0);
  expect(released).toBe(1);
  expect(ws.sent.length).toBe(count);
  expect(cable.stats().subscriptions).toEqual({});
});

test("unregistered module channels reject without starting an upstream", async () => {
  const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
  await registry.seed([{ id: "workspace", title: "Workspace" }]);
  const cable = createCableServer({ registry, events: createAtelierEventBus(), logError() {} });
  const ws = fakeSocket({ kind: "cable", connectionId: "unregistered" });
  cable.open(ws, ws.data);
  const identifier = CableTopics.module("missing", "workspace");
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "missing-1" }));
  await Bun.sleep(0);
  expect(ws.sent.at(-1)).toEqual({ type: "reject_subscription", identifier, subscriptionId: "missing-1", reason: "Unregistered Cable channel" });
  expect(cable.stats().upstreams).toEqual({});
  cable.close(ws);
});

test("module topic identity is independent of parameter insertion order", () => {
  expect(serializeCableIdentifier(CableTopics.module("tree", "workspace", { root: "a", filter: "b" })))
    .toBe(serializeCableIdentifier(CableTopics.module("tree", "workspace", { filter: "b", root: "a" })));
});

test("turn topics require all scope components and isolate branches", () => {
  const topic = CableTopics.agentTurn("workspace", "conversation", "entry:working", "session:leaf");
  expect(serializeCableIdentifier(topic)).toBe('["agent-turn","workspace","conversation","entry:working","session:leaf"]');
  for (const index of [0, 1, 2, 3]) {
    const scope: [string, string, string, string] = ["workspace", "conversation", "entry:working", "session:leaf"];
    scope[index] = "";
    expect(() => CableTopics.agentTurn(...scope)).toThrow("must not be empty");
    const raw = { ...topic, [ ["workspaceId", "conversationId", "turnId", "branchId"][index]! ]: "" };
    expect(() => decodeCableServerMessage(JSON.stringify({ type: "confirm_subscription", identifier: raw, subscriptionId: "1" }))).toThrow("unsupported cable server message");
  }
  expect(serializeCableIdentifier(topic)).not.toBe(serializeCableIdentifier(CableTopics.agentTurn("workspace", "conversation", "entry:working", "session:other")));
});

test("turn channels are lazy, independent per browser, and release obsolete generations", async () => {
  const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
  const listeners: ((html: string) => void)[] = [];
  let active = 0;
  const cable = createCableServer({
    registry, events: createAtelierEventBus(),
    channels: [
      { name: "agent", subscribe(_identifier, listener) { listener("main snapshot"); return { ready: Promise.resolve(), unsubscribe() {} }; } },
      { name: "agent-turn", subscribe(_identifier, listener) {
        listeners.push(listener);
        active++;
        listener("turn snapshot");
        return { ready: Promise.resolve(), unsubscribe() { active--; } };
      } },
    ],
  });
  const folded = fakeSocket({ kind: "cable", connectionId: "folded" });
  const expanded = fakeSocket({ kind: "cable", connectionId: "expanded" });
  for (const ws of [folded, expanded]) {
    cable.open(ws, ws.data);
    cable.message(ws, JSON.stringify({ command: "subscribe", subscriptionId: "main", identifier: CableTopics.agent("workspace", "conversation") }));
  }
  await Bun.sleep(0);
  expect(active).toBe(0);
  const foldedCount = folded.sent.length;
  const identifier = CableTopics.agentTurn("workspace", "conversation", "turn", "branch");
  for (let cycle = 0; cycle < 20; cycle++) {
    const subscriptionId = `turn-${cycle}`;
    cable.message(expanded, JSON.stringify({ command: "subscribe", subscriptionId, identifier }));
    await Bun.sleep(0);
    expect(active).toBe(1);
    const publish = listeners.at(-1)!;
    for (let update = 0; update < 100; update++) publish(`inner-${update}`);
    expect(folded.sent.length).toBe(foldedCount);
    cable.message(expanded, JSON.stringify({ command: "unsubscribe", subscriptionId: "obsolete", identifier }));
    expect(active).toBe(1);
    cable.message(expanded, JSON.stringify({ command: "unsubscribe", subscriptionId, identifier }));
    expect(active).toBe(0);
    const count = expanded.sent.length;
    for (const obsolete of listeners) obsolete("obsolete inner update");
    expect(expanded.sent.length).toBe(count);
  }
  expect(() => cable.broadcast(identifier, "bypass")).toThrow("live-presentation interface");
  cable.close(folded);
  cable.close(expanded);
  expect(cable.stats()).toEqual({ sockets: 0, subscriptions: {}, upstreams: {} });
});

test("turn channels reject invalid branch boundaries before delivering content", async () => {
  const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
  const cable = createCableServer({
    registry, events: createAtelierEventBus(), logError() {},
    channels: [{ name: "agent-turn", subscribe() { throw new Error("Turn does not belong to selected branch"); } }],
  });
  const ws = fakeSocket({ kind: "cable", connectionId: "invalid-turn" });
  cable.open(ws, ws.data);
  const identifier = CableTopics.agentTurn("workspace", "conversation", "foreign-turn", "branch");
  cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "turn" }));
  await Bun.sleep(0);
  expect(ws.sent).toEqual([
    { type: "welcome", connectionId: "invalid-turn" },
    { type: "reject_subscription", identifier, subscriptionId: "turn", reason: "Turn does not belong to selected branch" },
  ]);
  expect(cable.stats().upstreams).toEqual({});
  cable.close(ws);
});

for (const cancellation of ["unsubscribe", "close"] as const) {
  test(`turn ${cancellation} cancels a pending snapshot without delivering stale content`, async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const started = deferredSignal();
    const release = deferredSignal();
    let active = 0;
    const cable = createCableServer({
      registry, events: createAtelierEventBus(),
      channels: [{ name: "agent-turn", subscribe(_identifier, listener) {
        active++;
        return {
          ready: (async () => { started.resolve(); await release.promise; listener("stale snapshot"); })(),
          unsubscribe() { active--; },
        };
      } }],
    });
    const ws = fakeSocket({ kind: "cable", connectionId: "pending-turn" });
    cable.open(ws, ws.data);
    const identifier = CableTopics.agentTurn("workspace", "conversation", "turn", "branch");
    cable.message(ws, JSON.stringify({ command: "subscribe", identifier, subscriptionId: "pending" }));
    await started.promise;
    if (cancellation === "close") cable.close(ws);
    else cable.message(ws, JSON.stringify({ command: "unsubscribe", identifier, subscriptionId: "pending" }));
    expect(active).toBe(0);
    release.resolve();
    await Bun.sleep(0);
    expect(ws.sent).toEqual([{ type: "welcome", connectionId: "pending-turn" }]);
    cable.close(ws);
  });
}
