import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type WorkspacePhase = "starting" | "ready" | "checking_delete" | "deleting" | "failed";

export interface WorkspaceEntry {
  id: string;
  title: string | null;
  phase: WorkspacePhase;
  lastActivityAt: number;
  sourceRepositoryId: string | null;
  sourceRepositoryName: string | null;
  error?: string;
}

export type WorkspaceState = "busy" | "unread" | "idle";

export interface WorkspaceRegistryCallbacks {
  /** A single workspace changed (phase, title, busy, unread). tabKey is set when a tab status change triggered it. */
  rowChanged?(entry: WorkspaceEntry, context: { tabKey?: string }): void;
  /** List membership or ordering changed. */
  listChanged?(entries: WorkspaceEntry[]): void;
  /** A workspace was removed from the registry. */
  removed?(id: string): void;
}

export interface WorkspaceActivityStore {
  load(): Promise<Record<string, number>>;
  save(activity: Record<string, number>): Promise<void>;
}

export interface WorkspaceRegistryOptions {
  activityStore?: WorkspaceActivityStore;
  now?(): number;
}

const allowedTransitions: Record<WorkspacePhase, WorkspacePhase[]> = {
  starting: ["ready", "failed"],
  ready: ["checking_delete", "deleting"],
  checking_delete: ["ready", "deleting"],
  deleting: ["failed"],
  failed: [],
};

export function createFileWorkspaceActivityStore(path: string): WorkspaceActivityStore {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        return parsed && typeof parsed === "object" ? parsed as Record<string, number> : {};
      } catch {
        return {};
      }
    },
    async save(activity) {
      await mkdir(dirname(path), { recursive: true });
      const tempPath = `${path}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(activity, null, 2)}\n`);
      await rename(tempPath, path);
    },
  };
}

export interface WorkspaceRegistry {
  setCallbacks(callbacks: WorkspaceRegistryCallbacks): void;
  /** Seed from the containers Docker knows about. Replaces all current entries with phase "ready". */
  seed(workspaces: Array<{ id: string; title: string | null; sourceRepositoryId?: string | null; sourceRepositoryName?: string | null }>): Promise<void>;
  list(): WorkspaceEntry[];
  get(id: string): WorkspaceEntry | undefined;
  add(id: string, title?: string | null, sourceRepositoryId?: string | null, sourceRepositoryName?: string | null): WorkspaceEntry;
  setPhase(id: string, phase: WorkspacePhase, error?: string): void;
  setTitle(id: string, title: string | null): void;
  touch(id: string): void;
  remove(id: string): void;
  setActiveWorkspace(id: string | undefined): void;
  activeWorkspaceId(): string | undefined;
  setTabBusy(id: string, tabKey: string, busy: boolean): void;
  setTabUnread(id: string, tabKey: string, unread: boolean): void;
  clearWorkspaceUnread(id: string): void;
  isTabBusy(id: string, tabKey: string): boolean;
  isTabUnread(id: string, tabKey: string): boolean;
  tabUnreadAt(id: string, tabKey: string): number | undefined;
  isWorkspaceBusy(id: string): boolean;
  isWorkspaceUnread(id: string): boolean;
  workspaceUnreadAt(id: string): number | undefined;
  workspaceState(id: string): WorkspaceState;
  oldestUnreadWorkspace(): WorkspaceEntry | undefined;
  busyTabs(id: string): string[];
  unreadTabs(id: string): string[];
  statusTabs(id: string): string[];
}

export function createWorkspaceRegistry(options: WorkspaceRegistryOptions = {}): WorkspaceRegistry {
  const now = options.now ?? Date.now;
  const store = options.activityStore;
  const entries = new Map<string, WorkspaceEntry>();
  const tabBusy = new Map<string, Map<string, boolean>>();
  const tabUnread = new Map<string, Map<string, number>>();
  let activity: Record<string, number> = {};
  let activeWorkspace: string | undefined;
  let callbacks: WorkspaceRegistryCallbacks = {};

  function sorted(): WorkspaceEntry[] {
    return [...entries.values()].sort((a, b) => (b.lastActivityAt - a.lastActivityAt) || a.id.localeCompare(b.id));
  }

  function order(): string {
    return sorted().map((entry) => entry.id).join("\n");
  }

  function persistActivity(): void {
    if (!store) return;
    void store.save(activity).catch((error) => console.error("could not persist workspace activity", error));
  }

  function requireEntry(id: string): WorkspaceEntry {
    const entry = entries.get(id);
    if (!entry) throw new Error(`workspace not in registry: ${id}`);
    return entry;
  }

  return {
    setCallbacks(next) {
      callbacks = next;
    },

    async seed(workspaces) {
      activity = store ? await store.load() : {};
      entries.clear();
      for (const workspace of workspaces) {
        entries.set(workspace.id, {
          id: workspace.id,
          title: workspace.title,
          phase: "ready",
          lastActivityAt: activity[workspace.id] ?? 0,
          sourceRepositoryId: workspace.sourceRepositoryId ?? null,
          sourceRepositoryName: workspace.sourceRepositoryName ?? null,
        });
      }
      callbacks.listChanged?.(sorted());
    },

    list() {
      return sorted();
    },

    get(id) {
      return entries.get(id);
    },

    add(id, title = null, sourceRepositoryId = null, sourceRepositoryName = null) {
      if (entries.has(id)) throw new Error(`workspace already in registry: ${id}`);
      const entry: WorkspaceEntry = { id, title, phase: "starting", lastActivityAt: now(), sourceRepositoryId, sourceRepositoryName };
      entries.set(id, entry);
      activity[id] = entry.lastActivityAt;
      persistActivity();
      callbacks.listChanged?.(sorted());
      return entry;
    },

    setPhase(id, phase, error) {
      const entry = requireEntry(id);
      if (entry.phase === phase) return;
      if (!allowedTransitions[entry.phase].includes(phase)) {
        throw new Error(`illegal workspace phase transition: ${entry.phase} -> ${phase} (${id})`);
      }
      entry.phase = phase;
      entry.error = phase === "failed" ? error : undefined;
      callbacks.rowChanged?.(entry, {});
    },

    setTitle(id, title) {
      const entry = entries.get(id);
      if (!entry || entry.title === title) return;
      entry.title = title;
      callbacks.rowChanged?.(entry, {});
    },

    touch(id) {
      const entry = entries.get(id);
      if (!entry) return;
      const before = order();
      entry.lastActivityAt = now();
      activity[id] = entry.lastActivityAt;
      persistActivity();
      if (order() !== before) callbacks.listChanged?.(sorted());
    },

    remove(id) {
      if (!entries.delete(id)) return;
      tabBusy.delete(id);
      tabUnread.delete(id);
      if (activeWorkspace === id) activeWorkspace = undefined;
      callbacks.removed?.(id);
      callbacks.listChanged?.(sorted());
    },

    setActiveWorkspace(id) {
      activeWorkspace = id && entries.has(id) ? id : undefined;
    },

    activeWorkspaceId() {
      return activeWorkspace;
    },

    setTabBusy(id, tabKey, busy) {
      let tabs = tabBusy.get(id);
      if (!tabs) {
        tabs = new Map();
        tabBusy.set(id, tabs);
      }
      if ((tabs.get(tabKey) ?? false) === busy) return;
      if (busy) tabs.set(tabKey, true);
      else tabs.delete(tabKey);
      if (tabs.size === 0) tabBusy.delete(id);
      const entry = entries.get(id);
      if (entry) callbacks.rowChanged?.(entry, { tabKey });
    },

    setTabUnread(id, tabKey, unread) {
      let tabs = tabUnread.get(id);
      if (!tabs) {
        tabs = new Map();
        tabUnread.set(id, tabs);
      }
      if (tabs.has(tabKey) === unread) return;
      if (unread) tabs.set(tabKey, now());
      else tabs.delete(tabKey);
      if (tabs.size === 0) tabUnread.delete(id);
      const entry = entries.get(id);
      if (entry) callbacks.rowChanged?.(entry, { tabKey });
    },

    clearWorkspaceUnread(id) {
      const tabs = tabUnread.get(id);
      if (!tabs) return;
      const cleared = [...tabs.keys()];
      tabUnread.delete(id);
      const entry = entries.get(id);
      if (!entry) return;
      for (const tabKey of cleared) callbacks.rowChanged?.(entry, { tabKey });
    },

    isTabBusy(id, tabKey) {
      return tabBusy.get(id)?.get(tabKey) ?? false;
    },

    isTabUnread(id, tabKey) {
      return tabUnread.get(id)?.has(tabKey) ?? false;
    },

    tabUnreadAt(id, tabKey) {
      return tabUnread.get(id)?.get(tabKey);
    },

    isWorkspaceBusy(id) {
      return [...(tabBusy.get(id)?.values() ?? [])].some(Boolean);
    },

    isWorkspaceUnread(id) {
      return (tabUnread.get(id)?.size ?? 0) > 0;
    },

    workspaceUnreadAt(id) {
      const timestamps = [...(tabUnread.get(id)?.values() ?? [])];
      return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
    },

    workspaceState(id) {
      if (this.isWorkspaceBusy(id)) return "busy";
      if (this.isWorkspaceUnread(id)) return "unread";
      return "idle";
    },

    oldestUnreadWorkspace() {
      return [...entries.values()]
        .filter((entry) => entry.phase === "ready" && this.isWorkspaceUnread(entry.id))
        .sort((a, b) => (this.workspaceUnreadAt(a.id)! - this.workspaceUnreadAt(b.id)!) || a.id.localeCompare(b.id))[0];
    },

    busyTabs(id) {
      return [...(tabBusy.get(id)?.keys() ?? [])];
    },

    unreadTabs(id) {
      return [...(tabUnread.get(id)?.keys() ?? [])];
    },

    statusTabs(id) {
      return [...new Set([...this.busyTabs(id), ...this.unreadTabs(id)])];
    },
  };
}
