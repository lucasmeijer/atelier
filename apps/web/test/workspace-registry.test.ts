import { describe, expect, test } from "bun:test";
import { createWorkspaceRegistry, type WorkspaceActivityStore, type WorkspaceEntry, type WorkspaceUnreadStore } from "../src/server/workspace-registry.ts";

interface Captured {
  rows: Array<{ entry: WorkspaceEntry; tabKey?: string }>;
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

function setup(options: { activity?: Record<string, number>; unread?: Record<string, number>; now?: () => number } = {}) {
  const store = memoryStore(options.activity);
  const unreadStore = memoryStore(options.unread) as WorkspaceUnreadStore & { saved: Record<string, number>[] };
  const registry = createWorkspaceRegistry({ activityStore: store, unreadStore, now: options.now });
  const captured: Captured = { rows: [], lists: [], removed: [], parked: [] };
  registry.setCallbacks({
    rowChanged: (entry, { tabKey }) => captured.rows.push({ entry: { ...entry }, tabKey }),
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

    registry.setTabBusy("parked", "agent:1", true);

    expect(registry.get("parked")?.parked).toBe(false);
    expect(captured.parked.at(-1)?.id).toBe("parked");
    expect(captured.rows.map((row) => row.tabKey)).toEqual(["agent:1"]);
    expect(captured.lists).toHaveLength(1);
    expect(registry.list().map((entry) => entry.id)).toEqual(["parked", "active"]);
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

  test("tab busy and workspace unread aggregate with busy taking precedence, never reordering", async () => {
    const { registry, captured } = setup({ activity: { a: 200, b: 100 } });
    await registry.seed([
      { id: "a", title: null },
      { id: "b", title: null },
    ]);
    captured.lists.length = 0;
    captured.rows.length = 0;

    registry.setTabUnread("b", "agent:1", true);
    registry.setTabUnread("b", "agent:1", true);
    expect(registry.isWorkspaceUnread("b")).toBe(true);
    expect(registry.workspaceUnreadAt("b")).toBeDefined();
    expect(registry.workspaceState("b")).toBe("unread");

    registry.setTabBusy("b", "terminal:1", true);
    expect(registry.isWorkspaceBusy("b")).toBe(true);
    expect(registry.isTabBusy("b", "terminal:1")).toBe(true);
    expect(registry.workspaceState("b")).toBe("busy");
    expect(registry.busyTabs("b")).toEqual(["terminal:1"]);
    expect(captured.rows.map((row) => row.tabKey)).toEqual(["agent:1", "agent:1", "terminal:1"]);
    expect(captured.lists).toHaveLength(0);

    registry.setTabBusy("b", "terminal:1", false);
    expect(registry.workspaceState("b")).toBe("unread");
    registry.setActiveWorkspace("b");
    expect(registry.isWorkspaceUnread("b")).toBe(false);
    expect(registry.workspaceState("b")).toBe("idle");
  });

  test("active workspace does not become unread", async () => {
    const { registry, unreadStore } = setup();
    await registry.seed([{ id: "a", title: null }, { id: "b", title: null }]);

    registry.setActiveWorkspace("a");
    registry.setTabUnread("a", "agent:1", true);
    registry.setTabUnread("b", "agent:1", true);

    expect(registry.isWorkspaceUnread("a")).toBe(false);
    expect(registry.isWorkspaceUnread("b")).toBe(true);
    registry.setActiveWorkspace("b");
    expect(registry.isWorkspaceUnread("b")).toBe(false);
    expect(unreadStore.saved.at(-1)).toEqual({});
  });

  test("persisted workspace unread state is loaded on seed", async () => {
    const { registry } = setup({ unread: { a: 123 } });
    await registry.seed([{ id: "a", title: null }]);
    expect(registry.isWorkspaceUnread("a")).toBe(true);
    expect(registry.workspaceUnreadAt("a")).toBe(123);
  });

  test("oldestUnreadWorkspace returns the ready workspace with earliest unread timestamp", async () => {
    let clock = 100;
    const { registry } = setup({ now: () => ++clock });
    await registry.seed([
      { id: "a", title: null },
      { id: "b", title: null },
      { id: "c", title: null },
    ]);

    registry.setTabUnread("b", "agent:1", true);
    registry.setTabUnread("a", "agent:1", true);
    expect(registry.oldestUnreadWorkspace()?.id).toBe("b");

    registry.setActiveWorkspace("b");
    expect(registry.oldestUnreadWorkspace()?.id).toBe("a");

    registry.setActiveWorkspace("a");
    expect(registry.oldestUnreadWorkspace()).toBeUndefined();
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
