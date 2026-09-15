import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atelierDataPath, getAtelierRuntimeContext } from "@atelier/core";
import type { WorkspaceAppRef } from "@atelier/shared";
import type { PortRange } from "./tailscale-serve.ts";

export interface OriginAssignment { port: number; fresh: boolean }
export interface RetainedOrigin { app: WorkspaceAppRef; port: number; protocol: "http" | "https" }
export interface OriginIdentityStore {
  assignedPort(app: WorkspaceAppRef, range: PortRange, protocol?: "http" | "https"): Promise<OriginAssignment>;
  rejectFreshPort(app: WorkspaceAppRef, port: number): Promise<void>;
  list(): Promise<RetainedOrigin[]>;
  removeWorkspace(workspaceId: string): Promise<void>;
}
interface State { version: 2; assignments: RetainedOrigin[]; retiredPorts: number[] }
const empty = (): State => ({ version: 2, assignments: [], retiredPorts: [] });
const same = (a: WorkspaceAppRef, b: WorkspaceAppRef) => a.workspaceId === b.workspaceId && a.appKey === b.appKey;

function store(read: () => Promise<State>, write: (state: State) => Promise<void>, lock: <T>(fn: () => Promise<T>) => Promise<T>): OriginIdentityStore {
  return {
    assignedPort(app, range, protocol = "http") { return lock(async () => {
      const state = await read();
      const existing = state.assignments.find((entry) => same(entry.app, app));
      if (existing) {
        if (existing.protocol !== protocol) throw new Error("This workspace port is already published with a different protocol");
        if (existing.port < range.start || existing.port > range.end) throw new Error(`Retained browser origin ${existing.port} is outside the configured range`);
        return { port: existing.port, fresh: false };
      }
      const used = new Set([...state.assignments.map((entry) => entry.port), ...state.retiredPorts]);
      for (let port = range.start; port <= range.end; port++) {
        if (used.has(port)) continue;
        state.assignments.push({ app, port, protocol });
        await write(state);
        return { port, fresh: true };
      }
      throw new Error(`Workspace ingress origin capacity exhausted in range ${range.start}-${range.end}`);
    }); },
    rejectFreshPort(app, port) { return lock(async () => {
      const state = await read();
      state.assignments = state.assignments.filter((entry) => !(same(entry.app, app) && entry.port === port));
      if (!state.retiredPorts.includes(port)) state.retiredPorts.push(port);
      await write(state);
    }); },
    list() { return lock(async () => (await read()).assignments); },
    removeWorkspace(workspaceId) { return lock(async () => {
      const state = await read();
      for (const entry of state.assignments.filter((entry) => entry.app.workspaceId === workspaceId)) state.retiredPorts.push(entry.port);
      state.assignments = state.assignments.filter((entry) => entry.app.workspaceId !== workspaceId);
      await write(state);
    }); },
  };
}

export function createFileOriginIdentityStore(path = atelierDataPath(getAtelierRuntimeContext(), "proxy", "origin-identities.json")): OriginIdentityStore {
  const lock = serialize();
  return store(async () => {
    let text: string;
    try { text = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw error; }
    const state = JSON.parse(text) as State;
    if (state.version !== 2 || !Array.isArray(state.assignments) || !Array.isArray(state.retiredPorts)) throw new Error("Invalid ingress origin state");
    for (const entry of state.assignments) {
      if (!entry.app || typeof entry.app.workspaceId !== "string" || typeof entry.app.appKey !== "string" || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535 || !["http", "https"].includes(entry.protocol)) throw new Error("Invalid ingress origin assignment");
    }
    return state;
  }, async (state) => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, path);
  }, lock);
}

export function createMemoryOriginIdentityStore(): OriginIdentityStore {
  let state = empty();
  return store(async () => state, async (next) => { state = next; }, serialize());
}

// The app process owns this file. Atomic rename protects restarts; an on-disk
// lock would outlive a killed app and prevent its replacement from restoring.
function serialize() {
  let pending = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = pending.then(fn);
    pending = next.then(() => {}, () => {});
    return next;
  };
}
