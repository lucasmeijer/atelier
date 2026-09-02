import { describe, expect, test } from "bun:test";
import { createWorkspaceRegistry, type WorkspaceActivityStore, type WorkspaceEntry, type WorkspaceUnreadSnapshot, type WorkspaceUnreadStore } from "../src/server/workspace-registry.ts";

interface Captured {
  rows: Array<{ entry: WorkspaceEntry; viewKey?: string }>;
  lists: WorkspaceEntry[][];
  removed: string[];
  parked: WorkspaceEntry[];
}

function memoryStore(initial: Record<string, number> = {}): WorkspaceActivityStore & { saved: Record<string, number>[] } {
  const saved: Record<string, number>[] = [];
  return {
    saved,
    async load() {
      return { ...initial };
    },
    async save(activity) {
      saved.push({ ...activity });
    },
  };
}

function memoryUnreadStore(initial: WorkspaceUnreadSnapshot = { nextToken: 1, views: {} }): WorkspaceUnreadStore & { saved: WorkspaceUnreadSnapshot[] } {
  const saved: WorkspaceUnreadSnapshot[] = [];
  return {
    saved,
    async load() {
      return structuredClone(saved.at(-1) ?? initial);
    },
    async save(unread) {
      saved.push(structuredClone(unread));
    },
  };
}

function setup(options: { activity?: Record<string, number>; unread?: WorkspaceUnreadSnapshot; now?: () => number } = {}) {
  const store = memoryStore(options.activity);
  const unreadStore = memoryUnreadStore(options.unread);
  const registry = createWorkspaceRegistry({ activityStore: store, unreadStore, now: options.now });
  const captured: Captured = { rows: [], lists: [], removed: [], parked: [] };
  registry.setCallbacks({
    rowChanged: (entry, { viewKey }) => captured.rows.push({ entry: { ...entry }, viewKey }),
    parkedChanged: (entry) => captured.parked.push({ ...entry }),
    listChanged: (entries) => captured.lists.push(entries.map((entry) => ({ ...entry }))),
    removed: (id) => captured.removed.push(id),
  });
  return { registry, captured, store, unreadStore };
}

describe("workspace registry", () => {
  test("seed creates ready entries ordered by persisted activity, unknown workspaces last", async () => {
    const { registry, captured, store } = setup({ activity: { deleted: 300, b: 200, a: 100 } });
    await registry.seed([
      { id: "a", title: "A" },
      { id: "b", title: null },
      { id: "c", title: "C" },
    ]);

    expect(registry.list().map((entry) => entry.id)).toEqual(["b", "a", "c"]);
    expect(registry.list().every((entry) => entry.phase === "ready")).toBe(true);
    expect(captured.lists).toHaveLength(1);
    expect(store.saved.at(-1)).toEqual({ b: 200, a: 100 });
  });

  test("seed restores and prunes persisted workspace deletion state", async () => {
    const saved: Array<Record<string, import("../src/server/workspace-registry.ts").WorkspaceDeletionState>> = [];
    const deletionStore = {
      load: async () => ({
        blocked: { status: "blocked" as const, issues: [{ repo: "work", uncommittedPaths: ["changed.ts"], outgoingCommits: [] }] },
        removed: { status: "deleting" as const, forced: true },
      }),
      save: async (deletions: Record<string, import("../src/server/workspace-registry.ts").WorkspaceDeletionState>) => { saved.push(structuredClone(deletions)); },
    };
    const registry = createWorkspaceRegistry({ deletionStore });

    await registry.seed([{ id: "blocked", title: "Blocked" }, { id: "ready", title: "Ready" }]);

    expect(registry.get("blocked")?.phase).toBe("checking_delete");
    expect(registry.get("blocked")?.deletion?.status).toBe("blocked");
    expect(registry.get("ready")?.phase).toBe("ready");
    expect(saved.at(-1)).toEqual({ blocked: { status: "blocked", issues: [{ repo: "work", uncommittedPaths: ["changed.ts"], outgoingCommits: [] }] } });
  });

  test("parked workspaces sort below unparked workspaces", async () => {
    const { registry, captured } = setup({ activity: { parked: 300, active: 100, older: 50 } });
    await registry.seed([
      { id: "parked", title: "Parked", parked: true },
      { id: "active", title: "Active" },
      { id: "older", title: "Older" },
    ]);

    expect(registry.list().map((entry) => entry.id)).toEqual(["active", "older", "parked"]);

    captured.lists.length = 0;
    registry.setParked("active", true);
    expect(captured.parked.at(-1)?.id).toBe("active");
    expect(registry.list().map((entry) => entry.id)).toEqual(["older", "parked", "active"]);
    expect(captured.lists).toHaveLength(1);
  });

  test("busy parked workspaces auto unpark and move back into active ordering", async () => {
    const { registry, captured } = setup({ activity: { parked: 300, active: 100 } });
    await registry.seed([
      { id: "parked", title: "Parked", parked: true },
      { id: "active", title: "Active" },
    ]);
    captured.lists.length = 0;

    registry.setViewBusy("parked", "agent:53fc77b7-dc19-42d5-b200-2e134ec67529", true);

    expect(registry.get("parked")?.parked).toBe(false);
    expect(captured.parked.at(-1)?.id).toBe("parked");
    expect(captured.rows.map((row) => row.viewKey)).toEqual(["agent:53fc77b7-dc19-42d5-b200-2e134ec67529"]);
    expect(captured.lists).toHaveLength(1);
    expect(registry.list().map((entry) => entry.id)).toEqual(["parked", "active"]);
  });

  test("Agent completion unparks a parked Workspace", async () => {
    const { registry, captured } = setup({ activity: { parked: 300, active: 100 } });
    await registry.seed([
      { id: "parked", title: "Parked", parked: true },
      { id: "active", title: "Active" },
    ]);
    captured.lists.length = 0;

    registry.markViewAttention("parked", "agent:53fc77b7-dc19-42d5-b200-2e134ec67529");

    expect(registry.get("parked")?.parked).toBe(false);
    expect(registry.hasAttention("parked")).toBe(true);
    expect(captured.parked.at(-1)?.id).toBe("parked");
    expect(captured.rows.map((row) => row.viewKey)).toEqual(["agent:53fc77b7-dc19-42d5-b200-2e134ec67529"]);
    expect(captured.lists).toHaveLength(1);
  });

  test("add inserts a starting entry at the top and emits a list change", async () => {
    const { registry, captured } = setup({ activity: { a: 100 } });
    await registry.seed([{ id: "a", title: "A" }]);

    const entry = registry.add("new1");

    expect(entry.phase).toBe("starting");
    expect(registry.list()[0]?.id).toBe("new1");
    expect(captured.lists).toHaveLength(2);
  });

  test("legal phase transitions emit row changes; illegal transitions throw", async () => {
    const { registry, captured } = setup();
    await registry.seed([]);
    registry.add("w");
    captured.rows.length = 0;

    registry.setPhase("w", "ready");
    expect(captured.rows.map((row) => row.entry.phase)).toEqual(["ready"]);

    registry.setPhase("w", "checking_delete");
    registry.setPhase("w", "ready"); // delete denied
    registry.setPhase("w", "checking_delete");
    registry.setPhase("w", "deleting");
    expect(captured.rows).toHaveLength(5);

    expect(() => registry.setPhase("w", "ready")).toThrow(/illegal workspace phase transition/);
    expect(registry.get("w")?.phase).toBe("deleting");
  });

  test("failed phase records the error and clears it on other transitions", async () => {
    const { registry } = setup();
    await registry.seed([]);
    registry.add("w");
    registry.setPhase("w", "failed", "boom");
    expect(registry.get("w")?.error).toBe("boom");
    registry.setPhase("w", "deleting");
    expect(registry.get("w")?.error).toBeUndefined();
  });

  test("touch reorders, persists activity, and emits a list change only when order changes", async () => {
    let clock = 1000;
    const { registry, captured, store } = setup({ activity: { a: 300, b: 200 }, now: () => ++clock });
    await registry.seed([
      { id: "a", title: null },
      { id: "b", title: null },
    ]);
    captured.lists.length = 0;

    registry.touch("a"); // already at the top: no reorder
    expect(captured.lists).toHaveLength(0);

    registry.touch("b"); // moves to the top
    expect(captured.lists).toHaveLength(1);
    expect(registry.list().map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(store.saved.at(-1)?.b).toBeGreaterThan(300);
  });

  test("view activity remains available without changing Workspace Attention or ordering", async () => {
    const { registry, captured } = setup({ activity: { a: 200, b: 100 } });
    await registry.seed([
      { id: "a", title: null },
      { id: "b", title: null },
    ]);
    captured.lists.length = 0;
    captured.rows.length = 0;

    const agentKey = "agent:53fc77b7-dc19-42d5-b200-2e134ec67529";
    registry.markViewAttention("b", agentKey);
    expect(registry.hasAttention("b")).toBe(true);
    expect(registry.workspaceAttentionAt("b")).toBeDefined();

    registry.setViewBusy("b", "terminal:1", true);
    expect(registry.busyViews("b")).toEqual(["terminal:1"]);
    expect(captured.rows.map((row) => row.viewKey)).toEqual([agentKey, "terminal:1"]);
    expect(captured.lists).toHaveLength(0);

    registry.setViewBusy("b", "terminal:1", false);
    registry.clearViewAttention("b", agentKey);
    expect(registry.hasAttention("b")).toBe(false);
  });

  test("repeated completion preserves first-unread ordering and stale acknowledgement cannot clear the newer occurrence", async () => {
    let clock = 100;
    const { registry } = setup({ now: () => ++clock });
    await registry.seed([{ id: "a", title: null }]);
    const agentKey = "agent:53fc77b7-dc19-42d5-b200-2e134ec67529";

    const firstToken = registry.markViewAttention("a", agentKey)!;
    const firstUnreadAt = registry.workspaceAttentionAt("a");
    const secondToken = registry.markViewAttention("a", agentKey)!;

    expect(secondToken).toBeGreaterThan(firstToken);
    expect(registry.workspaceAttentionAt("a")).toBe(firstUnreadAt);
    expect(registry.attentionTokens("a")).toEqual({ [agentKey]: secondToken });
    expect(registry.acknowledgeAttention("a", { [agentKey]: firstToken })).toEqual([]);
    expect(registry.attentionTokens("a")[agentKey] !== undefined).toBe(true);
    expect(registry.acknowledgeAttention("a", { [agentKey]: secondToken })).toEqual([agentKey]);
    expect(registry.attentionTokens("a")[agentKey] !== undefined).toBe(false);
  });

  test("per-Agent unread state persists until that exact view is acknowledged", async () => {
    const { registry, unreadStore, captured } = setup();
    await registry.seed([{ id: "a", title: null }]);
    const firstAgent = "agent:53fc77b7-dc19-42d5-b200-2e134ec67529";
    const secondAgent = "agent:268604ac-d16a-4a4a-ab1e-1ed3ca54687d";

    const firstToken = registry.markViewAttention("a", firstAgent)!;
    const secondToken = registry.markViewAttention("a", secondAgent)!;

    expect(registry.attentionTokens("a")[firstAgent] !== undefined).toBe(true);
    expect(registry.attentionTokens("a")[secondAgent] !== undefined).toBe(true);
    expect(registry.hasAttention("a")).toBe(true);

    expect(registry.acknowledgeAttention("a", { [firstAgent]: firstToken })).toEqual([firstAgent]);
    expect(registry.attentionTokens("a")[firstAgent] !== undefined).toBe(false);
    expect(registry.attentionTokens("a")[secondAgent] !== undefined).toBe(true);
    expect(registry.hasAttention("a")).toBe(true);
    expect(unreadStore.saved.at(-1)).toEqual({
      nextToken: 3,
      views: { a: { [secondAgent]: { unreadAt: expect.any(Number), token: secondToken } } },
    });

    expect(registry.acknowledgeAttention("a", { [secondAgent]: secondToken })).toEqual([secondAgent]);
    expect(registry.hasAttention("a")).toBe(false);
    expect(unreadStore.saved.at(-1)).toEqual({ nextToken: 3, views: {} });
    expect(captured.rows.map(({ viewKey }) => viewKey)).toEqual([
      firstAgent,
      secondAgent,
      undefined,
      undefined,
    ]);
  });

  test("persisted workspace unread state is loaded and pruned on seed", async () => {
    const agentKey = "agent:53fc77b7-dc19-42d5-b200-2e134ec67529";
    const { registry, unreadStore } = setup({ unread: { nextToken: 8, views: {
      a: { [agentKey]: { unreadAt: 123, token: 6 } },
      deleted: { workspace: { unreadAt: 456, token: 7 } },
    } } });
    await registry.seed([{ id: "a", title: null }]);
    expect(registry.hasAttention("a")).toBe(true);
    expect(registry.attentionTokens("a")[agentKey] !== undefined).toBe(true);
    expect(registry.workspaceAttentionAt("a")).toBe(123);
    expect(unreadStore.saved.at(-1)).toEqual({ nextToken: 8, views: { a: { [agentKey]: { unreadAt: 123, token: 6 } } } });
  });

  test("persisted exact Work-view unread state remains ready after registry restart", async () => {
    const unreadStore = memoryUnreadStore();
    const original = createWorkspaceRegistry({ unreadStore, now: () => 321 });
    await original.seed([{ id: "a", title: null }]);
    original.markViewAttention("a", "browser:preview", 7);
    await Bun.sleep(0);

    const restarted = createWorkspaceRegistry({ unreadStore });
    await restarted.seed([{ id: "a", title: null }]);

    expect(restarted.attentionTokens("a")["browser:preview"] !== undefined).toBe(true);
    expect(restarted.hasAttention("a")).toBe(true);
    expect(restarted.workspaceAttentionAt("a")).toBe(321);
    expect(restarted.oldestAttentionWorkspace()?.id).toBe("a");
  });

  test("oldestAttentionWorkspace includes operational failures and confirmation states", async () => {
    let clock = 100;
    const { registry } = setup({ now: () => ++clock });
    await registry.seed([
      { id: "blocked", title: null },
      { id: "ready", title: null },
    ]);
    registry.add("failed");
    registry.setPhase("failed", "failed", "provisioning failed");
    registry.setPhase("blocked", "checking_delete");

    registry.markViewAttention("failed", "workspace");
    registry.markViewAttention("blocked", "workspace");
    registry.markViewAttention("ready", "agent:53fc77b7-dc19-42d5-b200-2e134ec67529");
    expect(registry.oldestAttentionWorkspace()?.id).toBe("failed");

    registry.clearViewAttention("failed", "workspace");
    expect(registry.oldestAttentionWorkspace()?.id).toBe("blocked");

    registry.clearViewAttention("blocked", "workspace");
    expect(registry.oldestAttentionWorkspace()?.id).toBe("ready");

    registry.clearViewAttention("ready", "agent:53fc77b7-dc19-42d5-b200-2e134ec67529");
    expect(registry.oldestAttentionWorkspace()).toBeUndefined();
  });

  test("oldestAttentionWorkspace prefers a non-busy Workspace over an older busy one", async () => {
    let clock = 100;
    const { registry } = setup({ now: () => ++clock });
    await registry.seed([
      { id: "busy", title: null },
      { id: "ready", title: null },
    ]);

    registry.markViewAttention("busy", "agent:completed");
    registry.setViewBusy("busy", "agent:running", true);
    registry.markViewAttention("ready", "agent:completed");

    expect(registry.oldestAttentionWorkspace()?.id).toBe("ready");
  });

  test("remove deletes the entry, persisted activity, and emits removed + list change; unknown ids are a no-op", async () => {
    const { registry, captured, store } = setup({ activity: { a: 100 } });
    await registry.seed([{ id: "a", title: null }]);
    captured.lists.length = 0;

    registry.remove("a");
    expect(captured.removed).toEqual(["a"]);
    expect(captured.lists).toHaveLength(1);
    expect(registry.get("a")).toBeUndefined();
    expect(store.saved.at(-1)).toEqual({});

    registry.remove("a");
    expect(captured.removed).toEqual(["a"]);
  });

  test("setTitle updates and broadcasts a row change; same title is a no-op", async () => {
    const { registry, captured } = setup();
    await registry.seed([{ id: "a", title: "Old" }]);
    captured.rows.length = 0;

    registry.setTitle("a", "New");
    registry.setTitle("a", "New");
    expect(captured.rows).toHaveLength(1);
    expect(registry.get("a")?.title).toBe("New");
  });
});
