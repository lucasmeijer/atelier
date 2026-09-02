import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtelierEventBus, JsonObject } from "@atelier/core";
import type { WorkspaceDeletionReview } from "@atelier/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createWebApp } from "../../src/server/app.ts";
import { createWorkspaceRegistry } from "../../src/server/workspace-registry.ts";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type ProvisionWorkspace = Parameters<typeof createWebApp>[0]["provisionWorkspace"];
export type ProvisionWorkspaceOptions = Parameters<ProvisionWorkspace>[1];

interface TestAppOptions {
  provision?: ProvisionWorkspace;
  inspect?: (id: string) => Promise<string[]>;
  destroy?: (id: string) => Promise<void>;
  persistParked?: (id: string, parked: boolean) => Promise<void>;
  events?: AtelierEventBus;
}

const deletionDetailsSchema = Type.Object({ risks: Type.Array(Type.String()) });

function deletionReview(inspect: (id: string) => Promise<string[]>): WorkspaceDeletionReview {
  return {
    async inspect(workspaceId) {
      const risks = await inspect(workspaceId);
      if (!risks.length) return { status: "clear" };
      const details = { risks };
      return { status: "blocked", fingerprint: String(Bun.hash(JSON.stringify(details))), details };
    },
    renderEvidence(_workspaceId, details) {
      return Value.Parse(deletionDetailsSchema, details).risks.join("\n");
    },
  };
}

export function createTestApp(options: TestAppOptions = {}) {
  const registry = createWorkspaceRegistry({
    activityStore: { load: async () => ({}), save: async () => {} },
  });
  const app = createWebApp({
    registry,
    cable: { broadcast() {} },
    events: options.events,
    provisionWorkspace: options.provision ?? (async () => {}),
    provisioningHooks: [],
    deletionReview: deletionReview(options.inspect ?? (async () => [])),
    destroyWorkspace: options.destroy ?? (async () => {}),
    persistWorkspaceParked: options.persistParked ?? (async () => {}),
    logError: () => {},
  });
  return { app, registry };
}

export function temporaryAtelierDataDir() {
  let previous: string | undefined;
  let path: string | undefined;
  return {
    async setUp() {
      previous = process.env.ATELIER_DATA_DIR;
      path = await mkdtemp(join(tmpdir(), "atelier-web-test-"));
      process.env.ATELIER_DATA_DIR = path;
    },
    async tearDown() {
      if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
      else process.env.ATELIER_DATA_DIR = previous;
      if (path) await rm(path, { recursive: true, force: true });
      previous = undefined;
      path = undefined;
    },
  };
}

export function post(path: string): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { accept: "text/vnd.turbo-stream.html" },
  });
}

export function postForm(path: string, body: URLSearchParams): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { accept: "text/vnd.turbo-stream.html", "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

export function postJson(path: string, body: JsonObject): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
