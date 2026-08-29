import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atelierDataPath, createProcessFileLock, getAtelierRuntimeContext, isJsonObject } from "@atelier/core";
import type { WorkspaceAppRef } from "@atelier/shared";
import type { PortRange } from "./tailscale-serve.ts";

export interface OriginAssignment {
  port: number;
  fresh: boolean;
}

export interface OriginIdentityStore {
  assignedPort(app: WorkspaceAppRef, scope: "public" | "nested", range: PortRange): Promise<OriginAssignment>;
  rejectFreshPort(app: WorkspaceAppRef, scope: "public" | "nested", port: number): Promise<void>;
}

interface OriginIdentityState {
  version: 1;
  assignments: Record<string, number>;
  retiredPorts: number[];
}

const withOriginIdentityLock = createProcessFileLock({
  label: "workspace ingress origin identity",
  lockDir: () => atelierDataPath(getAtelierRuntimeContext(), "proxy", "origin-identities.lock"),
});

function statePath(): string {
  return atelierDataPath(getAtelierRuntimeContext(), "proxy", "origin-identities.json");
}

function emptyState(): OriginIdentityState {
  return { version: 1, assignments: {}, retiredPorts: [] };
}

async function readState(): Promise<OriginIdentityState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(), "utf8"));
    if (!isJsonObject(parsed) || parsed.version !== 1 || !isJsonObject(parsed.assignments) || !Array.isArray(parsed.retiredPorts)) throw new Error("invalid workspace ingress origin identity state");
    const assignments: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed.assignments)) {
      if (!Number.isInteger(value)) throw new Error(`invalid workspace ingress origin assignment: ${key}`);
      // SAFETY: Number.isInteger establishes the persisted assignment's numeric domain shape.
      assignments[key] = value as number;
    }
    const retiredPorts = parsed.retiredPorts.map(Number);
    if (!retiredPorts.every(Number.isInteger)) throw new Error("invalid retired workspace ingress origin port");
    return { version: 1, assignments, retiredPorts };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyState();
    throw error;
  }
}

async function writeState(state: OriginIdentityState): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, path);
}

function assignmentKey(app: WorkspaceAppRef, scope: "public" | "nested"): string {
  return `${scope}\0${app.workspaceId}\0${app.appKey}`;
}

export function createFileOriginIdentityStore(): OriginIdentityStore {
  return {
    async assignedPort(app, scope, range) {
      return await withOriginIdentityLock(async () => {
        const state = await readState();
        const key = assignmentKey(app, scope);
        const existing = state.assignments[key];
        if (existing !== undefined) {
          if (existing < range.start || existing > range.end) throw new Error(`Retained browser origin ${existing} for ${app.appKey} is outside the configured range ${range.start}-${range.end}`);
          return { port: existing, fresh: false };
        }

        const unavailable = new Set([...Object.values(state.assignments), ...state.retiredPorts]);
        for (let port = range.start; port <= range.end; port += 1) {
          if (unavailable.has(port)) continue;
          state.assignments[key] = port;
          await writeState(state);
          return { port, fresh: true };
        }
        throw new Error(`Workspace ingress origin capacity exhausted in range ${range.start}-${range.end}; enlarge the managed origin range`);
      });
    },
    async rejectFreshPort(app, scope, port) {
      await withOriginIdentityLock(async () => {
        const state = await readState();
        const key = assignmentKey(app, scope);
        if (state.assignments[key] !== port) return;
        delete state.assignments[key];
        if (!state.retiredPorts.includes(port)) state.retiredPorts.push(port);
        await writeState(state);
      });
    },
  };
}

export function createMemoryOriginIdentityStore(): OriginIdentityStore {
  const assignments = new Map<string, number>();
  const used = new Set<number>();
  return {
    async assignedPort(app, scope, range) {
      const key = assignmentKey(app, scope);
      const existing = assignments.get(key);
      if (existing !== undefined) return { port: existing, fresh: false };
      for (let port = range.start; port <= range.end; port += 1) {
        if (used.has(port)) continue;
        assignments.set(key, port);
        used.add(port);
        return { port, fresh: true };
      }
      throw new Error(`Workspace ingress origin capacity exhausted in range ${range.start}-${range.end}; enlarge the managed origin range`);
    },
    async rejectFreshPort(app, scope, port) {
      const key = assignmentKey(app, scope);
      if (assignments.get(key) === port) assignments.delete(key);
    },
  };
}
