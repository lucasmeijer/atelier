import { describe, expect, test } from "bun:test";
import { createCableServer, type CableSocketData } from "../src/server/cable.ts";
import { cableCursorIsNewer } from "../src/client/cable.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";

function fakeSocket(data: CableSocketData) {
  const sent: unknown[] = [];
  return {
    data,
    sent,
    send(value: string) { sent.push(JSON.parse(value)); return value.length; },
  } as unknown as { data: CableSocketData; sent: unknown[]; send(value: string): number };
}

test("cable cursors reject stale revisions from the same runtime", () => {
  expect(cableCursorIsNewer(undefined, "runtime:1")).toBe(true);
  expect(cableCursorIsNewer("runtime:4", "runtime:5")).toBe(true);
  expect(cableCursorIsNewer("runtime:4", "runtime:4")).toBe(false);
  expect(cableCursorIsNewer("runtime:4", "runtime:3")).toBe(false);
  expect(cableCursorIsNewer("old-runtime:12", "new-runtime:1")).toBe(true);
});

describe("cable server", () => {
  test("validates /cable upgrades", () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const cable = createCableServer({ registry });
    expect(cable.validate(new Request("http://test/cable"), new URL("http://test/cable"))?.kind).toBe("cable");
    expect(cable.validate(new Request("http://test/nope"), new URL("http://test/nope"))).toBeUndefined();
  });

  test("subscribes, broadcasts, unsubscribes, and cleans up on close", async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const cable = createCableServer({ registry, shellSnapshot: () => '<turbo-stream action="replace" target="initial"><template>ok</template></turbo-stream>' });
    const ws = fakeSocket({ kind: "cable", connectionId: "conn-1" });

    cable.open(ws as never);
    cable.message(ws as never, JSON.stringify({ command: "subscribe", identifier: { channel: "shell" } }));
    await Bun.sleep(0);

    expect(ws.sent).toContainEqual({ type: "welcome", connectionId: "conn-1" });
    expect(ws.sent).toContainEqual({ type: "confirm_subscription", identifier: { channel: "shell" } });
    expect(ws.sent).toContainEqual({ type: "turbo_stream", identifier: { channel: "shell" }, html: '<turbo-stream action="replace" target="initial"><template>ok</template></turbo-stream>' });

    cable.broadcast({ channel: "shell" }, '<turbo-stream action="replace" target="x"><template>1</template></turbo-stream>');
    expect(ws.sent).toContainEqual({ type: "turbo_stream", identifier: { channel: "shell" }, html: '<turbo-stream action="replace" target="x"><template>1</template></turbo-stream>' });

    cable.message(ws as never, JSON.stringify({ command: "unsubscribe", identifier: { channel: "shell" } }));
    cable.broadcast({ channel: "shell" }, '<turbo-stream action="replace" target="x"><template>2</template></turbo-stream>');
    expect(ws.sent).not.toContainEqual({ type: "turbo_stream", identifier: { channel: "shell" }, html: '<turbo-stream action="replace" target="x"><template>2</template></turbo-stream>' });

    cable.message(ws as never, JSON.stringify({ command: "subscribe", identifier: { channel: "shell" } }));
    await Bun.sleep(0);
    cable.close(ws as never);
    expect(cable.stats().sockets).toBe(0);
    expect(cable.stats().subscriptions).toEqual({});
  });

  test("rejects unauthorized workspace subscriptions", async () => {
    const registry = createWorkspaceRegistry({ activityStore: { load: async () => ({}), save: async () => {} } });
    const cable = createCableServer({ registry });
    const ws = fakeSocket({ kind: "cable", connectionId: "conn-1" });
    cable.open(ws as never);
    cable.message(ws as never, JSON.stringify({ command: "subscribe", identifier: { channel: "workspace", workspaceId: "missing" } }));
    await Bun.sleep(0);
    expect(ws.sent).toContainEqual({ type: "reject_subscription", identifier: { channel: "workspace", workspaceId: "missing" }, reason: "workspace not found: missing" });
  });
});
