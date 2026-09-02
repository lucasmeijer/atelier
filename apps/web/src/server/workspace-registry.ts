import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspaceDeleteSafetyIssue } from "@atelier/projects";
import type { WorkspaceInitInstruction } from "@atelier/workspace";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

export type WorkspacePhase = "starting" | "ready" | "checking_delete" | "deleting" | "failed";

export type WorkspaceDeletionState =
  | { status: "checking" }
  | { status: "blocked"; issues: WorkspaceDeleteSafetyIssue[] }
  | { status: "deleting"; forced: boolean }
  | { status: "failed"; operation: "checking"; error: string }
  | { status: "failed"; operation: "deleting"; forced: boolean; error: string };

export interface WorkspaceEntry {
  id: string;
  title: string | null;
  phase: WorkspacePhase;
  lastActivityAt: number;
  init: WorkspaceInitInstruction | undefined;
  parked: boolean;
  imageOutdated: boolean;
  deletion?: WorkspaceDeletionState;
  error?: string;
}

export interface WorkspaceRegistryCallbacks {
  /** A single workspace changed. viewKey is set when one view triggered the change. */
  rowChanged?(entry: WorkspaceEntry, context: { viewKey?: string }): void;
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

export interface WorkspaceUnreadOccurrence {
  /** First transition to unread; stable across repeated occurrences for oldest-ready ordering. */
  unreadAt: number;
  /** Exact occurrence identity used for compare-and-clear acknowledgement. */
  token: number;
}

export interface WorkspaceUnreadSnapshot {
  nextToken: number;
  views: Record<string, Record<string, WorkspaceUnreadOccurrence>>;
}

export interface WorkspaceUnreadStore {
  load(): Promise<WorkspaceUnreadSnapshot>;
  save(unread: WorkspaceUnreadSnapshot): Promise<void>;
}

export interface WorkspaceDeletionStore {
  load(): Promise<Record<string, WorkspaceDeletionState>>;
  save(deletions: Record<string, WorkspaceDeletionState>): Promise<void>;
}

export interface WorkspaceRegistryOptions {
  activityStore?: WorkspaceActivityStore;
  unreadStore?: WorkspaceUnreadStore;
  deletionStore?: WorkspaceDeletionStore;
  now?(): number;
}

type WorkspacePhaseTransitions = { [Phase in WorkspacePhase]: WorkspacePhase[] };

const allowedTransitions: WorkspacePhaseTransitions = {
  starting: ["ready", "deleting", "failed"],
  ready: ["checking_delete", "deleting"],
  checking_delete: ["ready", "deleting", "failed"],
  deleting: ["failed"],
  failed: ["ready", "checking_delete", "deleting"],
};

const workspaceTimestampsSchema = Type.Record(Type.String(), Type.Number());
const workspaceUnreadOccurrenceSchema = Type.Object({
  unreadAt: Type.Number(),
  token: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
const workspaceUnreadSchema = Type.Object({
  nextToken: Type.Integer({ minimum: 1 }),
  views: Type.Record(Type.String(), Type.Record(Type.String(), workspaceUnreadOccurrenceSchema)),
}, { additionalProperties: false });
const deleteSafetyIssueSchema = Type.Object({
  repo: Type.String(),
  uncommittedPaths: Type.Array(Type.String()),
  outgoingCommits: Type.Array(Type.Object({ hash: Type.String(), subject: Type.String() })),
});
const workspaceDeletionStateSchema = Type.Union([
  Type.Object({ status: Type.Literal("checking") }),
  Type.Object({ status: Type.Literal("blocked"), issues: Type.Array(deleteSafetyIssueSchema) }),
  Type.Object({ status: Type.Literal("deleting"), forced: Type.Boolean() }),
  Type.Object({ status: Type.Literal("failed"), operation: Type.Literal("checking"), error: Type.String() }),
  Type.Object({ status: Type.Literal("failed"), operation: Type.Literal("deleting"), forced: Type.Boolean(), error: Type.String() }),
]);
const workspaceDeletionsSchema = Type.Record(Type.String(), workspaceDeletionStateSchema);

interface FileValueStore<T> {
  load(): Promise<T>;
  save(values: T): Promise<void>;
}

function createFileValueStore<T>(path: string, schema: TSchema, empty: () => T): FileValueStore<T> {
  let saveChain = Promise.resolve();
  let tempCounter = 0;
  return {
    async load() {
      try {
        // SAFETY: The supplied schema validates every loaded value as T.
        return Value.Parse(schema, JSON.parse(await readFile(path, "utf8"))) as T;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return empty();
        throw error;
      }
    },
    save(values) {
      const nextSave = saveChain.catch(() => undefined).then(async () => {
        await mkdir(dirname(path), { recursive: true });
        const tempPath = `${path}.${process.pid}.${++tempCounter}.tmp`;
        await writeFile(tempPath, `${JSON.stringify(values, null, 2)}\n`);
        await rename(tempPath, path);
      });
      saveChain = nextSave;
      return nextSave;
    },
  };
}

export function createFileWorkspaceActivityStore(path: string): WorkspaceActivityStore {
  return createFileValueStore(path, workspaceTimestampsSchema, () => ({}));
}

export function createFileWorkspaceUnreadStore(path: string): WorkspaceUnreadStore {
  return createFileValueStore(path, workspaceUnreadSchema, () => ({ nextToken: 1, views: {} }));
}

export function createFileWorkspaceDeletionStore(path: string): WorkspaceDeletionStore {
  return createFileValueStore(path, workspaceDeletionsSchema, () => ({}));
}

export interface WorkspaceRegistry {
  setCallbacks(callbacks: WorkspaceRegistryCallbacks): void;
  /** Seed from the containers Docker knows about. Replaces all current entries with phase "ready". */
  seed(workspaces: Array<{ id: string; title: string | null; parked?: boolean; init?: WorkspaceInitInstruction; imageOutdated?: boolean }>): Promise<void>;
  list(): WorkspaceEntry[];
  get(id: string): WorkspaceEntry | undefined;
  add(id: string, title?: string | null, init?: WorkspaceInitInstruction): WorkspaceEntry;
  setPhase(id: string, phase: WorkspacePhase, error?: string): void;
  setDeletion(id: string, deletion: WorkspaceDeletionState | undefined): void;
  setTitle(id: string, title: string | null): void;
  setParked(id: string, parked: boolean): void;
  touch(id: string): void;
  remove(id: string): void;
  setViewBusy(id: string, viewKey: string, busy: boolean): void;
  markViewAttention(id: string, viewKey: string, token?: number): number | undefined;
  /** Clears only captured occurrences; Attention arriving after capture survives. */
  acknowledgeAttention(id: string, capturedTokens: Readonly<Record<string, number>>): string[];
  clearViewAttention(id: string, viewKey: string): void;
  attentionTokens(id: string): Record<string, number>;
  hasAttention(id: string): boolean;
  workspaceAttentionAt(id: string): number | undefined;
  oldestAttentionWorkspace(): WorkspaceEntry | undefined;
  busyViews(id: string): string[];
}

export function createWorkspaceRegistry(options: WorkspaceRegistryOptions = {}): WorkspaceRegistry {
  const now = options.now ?? Date.now;
  const store = options.activityStore;
  const unreadStore = options.unreadStore;
  const deletionStore = options.deletionStore;
  const entries = new Map<string, WorkspaceEntry>();
  const busyViewsByWorkspace = new Map<string, Set<string>>();
  let unreadViewsByWorkspace: Record<string, Record<string, WorkspaceUnreadOccurrence>> = {};
  let nextUnreadToken = 1;
  let workspaceDeletions: Record<string, WorkspaceDeletionState> = {};
  let activity: Record<string, number> = {};
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
    const snapshot = structuredClone({ nextToken: nextUnreadToken, views: unreadViewsByWorkspace });
    void unreadStore.save(snapshot).catch((error) => console.error("could not persist workspace unread state", error));
  }

  function persistDeletions(): void {
    if (!deletionStore) return;
    void deletionStore.save(workspaceDeletions).catch((error) => console.error("could not persist workspace deletion state", error));
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
      const loadedUnread = unreadStore ? await unreadStore.load() : { nextToken: 1, views: {} };
      nextUnreadToken = loadedUnread.nextToken;
      unreadViewsByWorkspace = Object.fromEntries(Object.entries(loadedUnread.views).filter(([id]) => workspaceIds.has(id)));
      if (Object.keys(unreadViewsByWorkspace).length !== Object.keys(loadedUnread.views).length) persistUnread();
      const loadedDeletions = deletionStore ? await deletionStore.load() : {};
      workspaceDeletions = Object.fromEntries(Object.entries(loadedDeletions).filter(([id]) => workspaceIds.has(id)));
      if (Object.keys(workspaceDeletions).length !== Object.keys(loadedDeletions).length) persistDeletions();
      entries.clear();
      for (const workspace of workspaces) {
        const deletion = workspaceDeletions[workspace.id];
        const phase: WorkspacePhase = deletion?.status === "deleting" ? "deleting" : deletion?.status === "failed" ? "failed" : deletion ? "checking_delete" : "ready";
        const entry: WorkspaceEntry = {
          id: workspace.id,
          title: workspace.title,
          phase,
          lastActivityAt: activity[workspace.id] ?? 0,
          init: workspace.init,
          parked: workspace.parked ?? false,
          imageOutdated: workspace.imageOutdated ?? false,
          deletion,
        };
        if (deletion?.status === "failed") entry.error = deletion.error;
        entries.set(workspace.id, entry);
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

    setDeletion(id, deletion) {
      const entry = requireEntry(id);
      const phase: WorkspacePhase = deletion?.status === "deleting" ? "deleting" : deletion?.status === "failed" ? "failed" : deletion ? "checking_delete" : "ready";
      if (entry.phase !== phase && !allowedTransitions[entry.phase].includes(phase)) throw new Error(`illegal workspace phase transition: ${entry.phase} -> ${phase} (${id})`);
      entry.phase = phase;
      entry.deletion = deletion;
      entry.error = deletion?.status === "failed" ? deletion.error : undefined;
      if (deletion) workspaceDeletions[id] = deletion;
      else delete workspaceDeletions[id];
      persistDeletions();
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
      busyViewsByWorkspace.delete(id);
      if (activity[id] !== undefined) {
        delete activity[id];
        persistActivity();
      }
      if (unreadViewsByWorkspace[id] !== undefined) {
        delete unreadViewsByWorkspace[id];
        persistUnread();
      }
      if (workspaceDeletions[id] !== undefined) {
        delete workspaceDeletions[id];
        persistDeletions();
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

    markViewAttention(id, viewKey, suppliedToken) {
      const entry = entries.get(id);
      if (!entry) return undefined;
      const token = suppliedToken ?? nextUnreadToken;
      if (!Number.isSafeInteger(token) || token < 1) throw new Error(`invalid unread occurrence token: ${token}`);
      if (suppliedToken === undefined || token >= nextUnreadToken) nextUnreadToken = token + 1;
      const unparked = entry.parked;
      if (unparked) {
        entry.parked = false;
        callbacks.parkedChanged?.(entry);
      }
      const views = unreadViewsByWorkspace[id] ?? {};
      const previous = views[viewKey];
      if (previous?.token === token) {
        if (unparked) callbacks.listChanged?.(sorted());
        return token;
      }
      views[viewKey] = { unreadAt: previous?.unreadAt ?? now(), token };
      unreadViewsByWorkspace[id] = views;
      persistUnread();
      callbacks.rowChanged?.(entry, { viewKey });
      if (unparked) callbacks.listChanged?.(sorted());
      return token;
    },

    acknowledgeAttention(id, capturedTokens) {
      const entry = entries.get(id);
      const views = unreadViewsByWorkspace[id];
      if (!entry || !views) return [];
      const acknowledged = Object.entries(capturedTokens)
        .filter(([viewKey, token]) => views[viewKey]?.token === token)
        .map(([viewKey]) => viewKey);
      if (acknowledged.length === 0) return acknowledged;
      for (const viewKey of acknowledged) delete views[viewKey];
      if (Object.keys(views).length === 0) delete unreadViewsByWorkspace[id];
      persistUnread();
      callbacks.rowChanged?.(entry, {});
      return acknowledged;
    },

    clearViewAttention(id, viewKey) {
      const entry = entries.get(id);
      const views = unreadViewsByWorkspace[id];
      if (!entry || !views?.[viewKey]) return;
      delete views[viewKey];
      if (Object.keys(views).length === 0) delete unreadViewsByWorkspace[id];
      persistUnread();
      callbacks.rowChanged?.(entry, { viewKey });
    },

    attentionTokens(id) {
      return Object.fromEntries(Object.entries(unreadViewsByWorkspace[id] ?? {}).map(([viewKey, occurrence]) => [viewKey, occurrence.token]));
    },

    hasAttention(id) {
      return unreadViewsByWorkspace[id] !== undefined;
    },

    workspaceAttentionAt(id) {
      const timestamps = Object.values(unreadViewsByWorkspace[id] ?? {}).map(({ unreadAt }) => unreadAt);
      return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
    },

    oldestAttentionWorkspace() {
      return [...entries.values()]
        .filter((entry) => this.hasAttention(entry.id))
        .sort((a, b) => Number(busyViewsByWorkspace.has(a.id)) - Number(busyViewsByWorkspace.has(b.id))
          || (this.workspaceAttentionAt(a.id)! - this.workspaceAttentionAt(b.id)!)
          || a.id.localeCompare(b.id))[0];
    },

    busyViews(id) {
      return [...(busyViewsByWorkspace.get(id) ?? [])];
    },
  };
}
