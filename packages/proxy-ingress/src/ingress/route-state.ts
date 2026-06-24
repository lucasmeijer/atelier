import { mkdir, readdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atelierDataPath, getAtelierRuntimeContext } from "@atelier/core";

export interface WorkspacePublicProxyRoute {
  appKey: string;
  publicPort: number;
}

interface WorkspacePublicProxyState {
  version: 1;
  routes: Record<string, { publicPort: number }>;
}

export interface PublicProxyPortRange {
  start: number;
  end: number;
}

export const defaultPublicProxyPortRange: PublicProxyPortRange = { start: 41000, end: 41999 };

let publicRoutesProcessLock: Promise<void> = Promise.resolve();

export function publicProxyPortRangeFromEnv(value = process.env.ATELIER_PROXY_PORT_RANGE): PublicProxyPortRange {
  if (!value?.trim()) return defaultPublicProxyPortRange;
  const match = value.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) throw new Error(`invalid ATELIER_PROXY_PORT_RANGE: ${value}`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end > 65535 || start > end) throw new Error(`invalid ATELIER_PROXY_PORT_RANGE: ${value}`);
  return { start, end };
}

function emptyState(): WorkspacePublicProxyState {
  return { version: 1, routes: {} };
}

async function workspaceProxyStatePath(workspaceId: string): Promise<string> {
  const runtime = await getAtelierRuntimeContext();
  return atelierDataPath(runtime, "workspaces", workspaceId, "proxy-routes.json");
}

async function readWorkspacePublicProxyState(workspaceId: string): Promise<WorkspacePublicProxyState> {
  return await readStatePath(await workspaceProxyStatePath(workspaceId));
}

async function writeWorkspacePublicProxyState(workspaceId: string, state: WorkspacePublicProxyState): Promise<void> {
  const path = await workspaceProxyStatePath(workspaceId);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temp, path);
}

async function readStatePath(path: string): Promise<WorkspacePublicProxyState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<WorkspacePublicProxyState>;
    if (parsed.version !== 1 || !parsed.routes || typeof parsed.routes !== "object") return emptyState();
    const routes: WorkspacePublicProxyState["routes"] = {};
    for (const [appKey, route] of Object.entries(parsed.routes)) {
      const publicPort = Number((route as { publicPort?: unknown }).publicPort);
      if (isValidAppKey(appKey) && Number.isInteger(publicPort)) routes[appKey] = { publicPort };
    }
    return { version: 1, routes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function listWorkspacePublicProxyRoutes(workspaceIds?: string[]): Promise<Array<{ workspaceId: string; appKey: string; publicPort: number }>> {
  const ids = workspaceIds ?? await listWorkspaceDirs();
  const routes: Array<{ workspaceId: string; appKey: string; publicPort: number }> = [];
  for (const workspaceId of ids) {
    const state = await readWorkspacePublicProxyState(workspaceId);
    for (const [appKey, route] of Object.entries(state.routes)) routes.push({ workspaceId, appKey, publicPort: route.publicPort });
  }
  return routes;
}

async function listWorkspaceDirs(): Promise<string[]> {
  const runtime = await getAtelierRuntimeContext();
  try {
    const entries = await readdir(atelierDataPath(runtime, "workspaces"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function ensureWorkspacePublicProxyRoute(workspaceId: string, appKey: string, options: { range?: PublicProxyPortRange; reservedPorts?: Iterable<number> } = {}): Promise<WorkspacePublicProxyRoute> {
  if (!isValidAppKey(appKey)) throw new Error(`invalid workspace proxy app key: ${appKey}`);
  return await withPublicRoutesLock(async () => {
    const range = options.range ?? publicProxyPortRangeFromEnv();
    const state = await readWorkspacePublicProxyState(workspaceId);
    const existing = state.routes[appKey]?.publicPort;
    if (existing && portInRange(existing, range) && !isReserved(existing, options.reservedPorts)) return { appKey, publicPort: existing };

    const used = new Set((await listWorkspacePublicProxyRoutes()).map((route) => route.publicPort));
    for (const port of options.reservedPorts ?? []) used.add(port);
    if (existing && !isReserved(existing, options.reservedPorts)) used.delete(existing);

    const publicPort = firstFreePort(range, used);
    if (!publicPort) throw new Error(`no public proxy ports available in range ${range.start}-${range.end}`);
    state.routes[appKey] = { publicPort };
    await writeWorkspacePublicProxyState(workspaceId, state);
    return { appKey, publicPort };
  });
}

export async function releaseWorkspacePublicProxyRoute(workspaceId: string, appKey: string): Promise<number | undefined> {
  return await withPublicRoutesLock(async () => {
    const state = await readWorkspacePublicProxyState(workspaceId);
    const publicPort = state.routes[appKey]?.publicPort;
    if (publicPort === undefined) return undefined;
    delete state.routes[appKey];
    await writeWorkspacePublicProxyState(workspaceId, state);
    return publicPort;
  });
}

export async function releaseWorkspacePublicProxyRoutes(workspaceId: string): Promise<number[]> {
  return await withPublicRoutesLock(async () => {
    const state = await readWorkspacePublicProxyState(workspaceId);
    const ports = Object.values(state.routes).map((route) => route.publicPort);
    if (ports.length) await writeWorkspacePublicProxyState(workspaceId, emptyState());
    return ports;
  });
}

async function withPublicRoutesLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = publicRoutesProcessLock;
  let releaseProcessLock!: () => void;
  publicRoutesProcessLock = new Promise<void>((resolve) => { releaseProcessLock = resolve; });
  await previous;

  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    releaseFileLock = await acquirePublicRoutesFileLock();
    return await fn();
  } finally {
    await releaseFileLock?.();
    releaseProcessLock();
  }
}

async function acquirePublicRoutesFileLock(): Promise<() => Promise<void>> {
  const runtime = await getAtelierRuntimeContext();
  const lockDir = atelierDataPath(runtime, "proxy", "public-routes.lock");
  await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      return async () => { await rmdir(lockDir).catch(() => {}); };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`timed out waiting for public proxy route lock: ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function isReserved(port: number, reservedPorts: Iterable<number> | undefined): boolean {
  if (!reservedPorts) return false;
  for (const reserved of reservedPorts) if (reserved === port) return true;
  return false;
}

function firstFreePort(range: PublicProxyPortRange, used: Set<number>): number | undefined {
  for (let port = range.start; port <= range.end; port++) if (!used.has(port)) return port;
  return undefined;
}

function portInRange(port: number, range: PublicProxyPortRange): boolean {
  return Number.isInteger(port) && port >= range.start && port <= range.end;
}

function isValidAppKey(appKey: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(appKey);
}
