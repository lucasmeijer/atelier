import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspaceInitInstruction } from "@atelier/workspace";

export type WorkspacePhase = "starting" | "ready" | "checking_delete" | "deleting" | "failed";

export interface WorkspaceEntry {
  id: string;
  title: string | null;
  phase: WorkspacePhase;
  lastActivityAt: number;
  init: WorkspaceInitInstruction | undefined;
  parked: boolean;
  imageOutdated: boolean;
  error?: string;
}

export type WorkspaceState = "busy" | "unread" | "idle";

export interface WorkspaceRegistryCallbacks {
  /** A single workspace changed (phase, title, busy, unread). viewKey is set when a view status change triggered it. */
  rowChanged?(entry: WorkspaceEntry, context: { viewKey?: string; unread?: boolean }): void;
  /** A workspace's parked state changed and should be persisted. */
  parkedChanged?(entry: WorkspaceEntry): void;
  /** List membership or ordering changed. */
  listChanged?(entries: WorkspaceEntry[]): void;
  /** A workspace was removed from the registry. */
  removed?(id: string): void;
}

export interface WorkspaceActivityStore {
  load(): Promise<Record<string, number>>;
  save(activity: Record<string, number>): Promise<void>;
}

export type WorkspaceUnreadStore = WorkspaceActivityStore;

export interface WorkspaceRegistryOptions {
  activityStore?: WorkspaceActivityStore;
  unreadStore?: WorkspaceUnreadStore;
  now?(): number;
}

interface WorkspacePhaseTransitions {
  starting: WorkspacePhase[];
  ready: WorkspacePhase[];
  checking_delete: WorkspacePhase[];
  deleting: WorkspacePhase[];
  failed: WorkspacePhase[];
}

const allowedTransitions: WorkspacePhaseTransitions = {
  starting: ["ready", "failed"],
  ready: ["checking_delete", "deleting"],
  checking_delete: ["ready", "deleting"],
  deleting: ["failed"],
  failed: ["deleting"],
};

function createFileTimestampStore(path: string): WorkspaceActivityStore {
  let saveChain = Promise.resolve();
  let tempCounter = 0;

  async function writeTimestamps(timestamps: Record<string, number>): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${++tempCounter}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(timestamps, null, 2)}\n`);
    await rename(tempPath, path);
  }

  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object`);
        const timestamps: Record<string, number> = {};
        for (const [workspaceId, timestamp] of Object.entries(parsed)) {
          if (typeof timestamp !== "number") throw new Error(`${path} contains a non-numeric timestamp for ${workspaceId}`);
          timestamps[workspaceId] = timestamp;
        }
        return timestamps;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
        throw error;
      }
    },
    save(timestamps) {
      const nextSave = saveChain.catch(() => undefined).then(() => writeTimestamps(timestamps));
      saveChain = nextSave;
      return nextSave;
    },
  };
}

export function createFileWorkspaceActivityStore(path: string): WorkspaceActivityStore {
  return createFileTimestampStore(path);
}

export function createFileWorkspaceUnreadStore(path: string): WorkspaceUnreadStore {
  return createFileTimestampStore(path);
}

export interface WorkspaceRegistry {
  setCallbacks(callbacks: WorkspaceRegistryCallbacks): void;
  /** Seed from the containers Docker knows about. Replaces all current entries with phase "ready". */
  seed(workspaces: Array<{ id: string; title: string | null; parked?: boolean; init?: WorkspaceInitInstruction; imageOutdated?: boolean }>): Promise<void>;
  list(): WorkspaceEntry[];
  get(id: string): WorkspaceEntry | undefined;
  add(id: string, title?: string | null, init?: WorkspaceInitInstruction): WorkspaceEntry;
  setPhase(id: string, phase: WorkspacePhase, error?: string): void;
  setTitle(id: string, title: string | null): void;
  setParked(id: string, parked: boolean): void;
  setActiveWorkspace(id: string | undefined): void;
  touch(id: string): void;
  remove(id: string): void;
  setViewBusy(id: string, viewKey: string, busy: boolean): void;
  setViewUnread(id: string, viewKey: string, unread: boolean): void;
  isViewBusy(id: string, viewKey: string): boolean;
  isWorkspaceBusy(id: string): boolean;
  isWorkspaceUnread(id: string): boolean;
  workspaceUnreadAt(id: string): number | undefined;
  workspaceState(id: string): WorkspaceState;
  oldestUnreadWorkspace(): WorkspaceEntry | undefined;
  busyViews(id: string): string[];
}

export function createWorkspaceRegistry(options: WorkspaceRegistryOptions = {}): WorkspaceRegistry {
  const now = options.now ?? Date.now;
  const store = options.activityStore;
  const unreadStore = options.unreadStore;
  const entries = new Map<string, WorkspaceEntry>();
  const busyViewsByWorkspace = new Map<string, Set<string>>();
  let workspaceUnread: Record<string, number> = {};
  let activity: Record<string, number> = {};
  let activeWorkspaceId: string | undefined;
  let callbacks: WorkspaceRegistryCallbacks = {};

  function sorted(): WorkspaceEntry[] {
    return [...entries.values()].sort((a, b) => Number(a.parked) - Number(b.parked) || (b.lastActivityAt - a.lastActivityAt) || a.id.localeCompare(b.id));
  }

  function order(): string {
    return sorted().map((entry) => entry.id).join("\n");
  }

  function persistActivity(): void {
    if (!store) return;
    void store.save(activity).catch((error) => console.error("could not persist workspace activity", error));
  }

  function persistUnread(): void {
    if (!unreadStore) return;
    void unreadStore.save(workspaceUnread).catch((error) => console.error("could not persist workspace unread state", error));
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
      const loadedActivity = store ? await store.load() : {};
      const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
      activity = Object.fromEntries(Object.entries(loadedActivity).filter(([id]) => workspaceIds.has(id)));
      if (Object.keys(activity).length !== Object.keys(loadedActivity).length) persistActivity();
      const loadedUnread = unreadStore ? await unreadStore.load() : {};
      workspaceUnread = Object.fromEntries(Object.entries(loadedUnread).filter(([id]) => workspaceIds.has(id)));
      if (Object.keys(workspaceUnread).length !== Object.keys(loadedUnread).length) persistUnread();
      entries.clear();
      for (const workspace of workspaces) {
        entries.set(workspace.id, {
          id: workspace.id,
          title: workspace.title,
          phase: "ready",
          lastActivityAt: activity[workspace.id] ?? 0,
          init: workspace.init,
          parked: workspace.parked ?? false,
          imageOutdated: workspace.imageOutdated ?? false,
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

    add(id, title = null, init) {
      if (entries.has(id)) throw new Error(`workspace already in registry: ${id}`);
      const entry: WorkspaceEntry = { id, title, phase: "starting", lastActivityAt: now(), init, parked: false, imageOutdated: false };
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

    setParked(id, parked) {
      const entry = entries.get(id);
      if (!entry || entry.parked === parked) return;
      entry.parked = parked;
      callbacks.parkedChanged?.(entry);
      callbacks.listChanged?.(sorted());
    },

    setActiveWorkspace(id) {
      activeWorkspaceId = id;
      if (!id || workspaceUnread[id] === undefined) return;
      delete workspaceUnread[id];
      persistUnread();
      const entry = entries.get(id);
      if (entry) callbacks.rowChanged?.(entry, {});
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
      if (activeWorkspaceId === id) activeWorkspaceId = undefined;
      busyViewsByWorkspace.delete(id);
      if (activity[id] !== undefined) {
        delete activity[id];
        persistActivity();
      }
      if (workspaceUnread[id] !== undefined) {
        delete workspaceUnread[id];
        persistUnread();
      }
      callbacks.removed?.(id);
      callbacks.listChanged?.(sorted());
    },

    setViewBusy(id, viewKey, busy) {
      const views = busyViewsByWorkspace.get(id);
      if ((views?.has(viewKey) ?? false) === busy) return;
      if (busy) {
        if (views) views.add(viewKey);
        else busyViewsByWorkspace.set(id, new Set([viewKey]));
      } else {
        views!.delete(viewKey);
        if (views!.size === 0) busyViewsByWorkspace.delete(id);
      }
      const entry = entries.get(id);
      if (!entry) return;
      if (busy && entry.parked) {
        entry.parked = false;
        callbacks.parkedChanged?.(entry);
        callbacks.rowChanged?.(entry, { viewKey });
        callbacks.listChanged?.(sorted());
        return;
      }
      callbacks.rowChanged?.(entry, { viewKey });
    },

    setViewUnread(id, viewKey, unread) {
      const entry = entries.get(id);
      if (!entry) return;
      const wasUnread = workspaceUnread[id] !== undefined;
      if (unread && id !== activeWorkspaceId) {
        if (!wasUnread) workspaceUnread[id] = now();
      } else delete workspaceUnread[id];
      const isUnread = workspaceUnread[id] !== undefined;
      if (isUnread !== wasUnread) persistUnread();
      if (unread || isUnread !== wasUnread) callbacks.rowChanged?.(entry, { viewKey, unread });
    },

    isViewBusy(id, viewKey) {
      return busyViewsByWorkspace.get(id)?.has(viewKey) ?? false;
    },

    isWorkspaceBusy(id) {
      return (busyViewsByWorkspace.get(id)?.size ?? 0) > 0;
    },

    isWorkspaceUnread(id) {
      return workspaceUnread[id] !== undefined;
    },

    workspaceUnreadAt(id) {
      return workspaceUnread[id];
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

    busyViews(id) {
      return [...(busyViewsByWorkspace.get(id) ?? [])];
    },
  };
}
