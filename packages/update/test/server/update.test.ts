import { expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import { UpdateManager, createUpdateRouteHandler, type UpdateManagerDeps } from "../../src/server/index.ts";
import { requestSupervisorUpdate } from "../../src/server/supervisor.ts";
import { readStoredReleaseChannel, writeStoredReleaseChannel } from "../../src/server/settings-store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function context() {
  const sidebar: string[] = [];
  const broadcasts: string[] = [];
  return {
    sidebar,
    broadcasts,
    ctx: {
      events: createAtelierEventBus(),
      registry: { setAgentBusy: () => {}, requestSurfaceAttention: () => undefined, requestAttention: () => undefined },
      globalSidebarContributions: { set: (_id: string, html?: string, options?: { broadcastHtml?: string }) => {
        sidebar.push(html ?? "");
        broadcasts.push(options?.broadcastHtml ?? "");
      } },
      createWorkView: async () => {},
      presentWorkView: async () => {},
      broadcastWorkspace: () => {},
      deleteCurrentWorkspace: async () => ({ deleted: false, blocked: false }),
      registerSocketHandler: () => {},
      publishWorkspacePort: async () => { throw new Error("not used"); },
      registerWorkspaceAppResolver: () => {},
      registerProvisioningHook: () => {},
      onWorkspaceRemoved: () => {},
    },
  };
}

function noInterval() {}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}


const oldDigest = `sha256:${"a".repeat(64)}`;
const newDigest = `sha256:${"b".repeat(64)}`;
const newerDigest = `sha256:${"c".repeat(64)}`;
const exact = `ghcr.io/lucasmeijer/atelier@${newDigest}`;
function manager(extra: UpdateManagerDeps = {}) {
  return new UpdateManager({
    detectRuntime: async () => ({ currentDigest: oldDigest }),
    fetchMetadata: async () => ({ digest: newDigest }),
    prepareUpdate: async (reference) => ({ reference, imageId: "sha256:prepared-image-id" }),
    setInterval: noInterval, ...extra,
  });
}
test("non-System installations neither discover updates nor accept update operations", async () => {
  const instance = manager({ detectRuntime: async () => undefined, fetchMetadata: async () => { throw new Error("must not check"); } });
  await instance.initialize(context().ctx);
  expect(instance.snapshot().selfUpdatable).toBe(false);
  expect(() => instance.startPull()).toThrow("System-managed");
  const route = createUpdateRouteHandler(instance);
  for (const path of ["/update/start", "/update/restart", "/update/check-now", "/settings/update-channel"]) {
    const url = new URL(path, "http://localhost");
    expect((await route(new Request(url, { method: "POST" }), url))!.status).toBe(409);
  }
});
test("download remains in progress until all preparation completes; restart uses the exact prepared image", async () => {
  const gate = deferred();
  const requests: string[] = [];
  const instance = manager({ prepareUpdate: async (reference, progress) => {
    expect(reference).toBe(exact);
    progress({ kind: "progress", percent: 60, message: "Downloading workspace image" });
    await gate.promise;
    return { reference, imageId: "sha256:prepared-image-id" };
  }, requestUpdate: async (image) => { requests.push(image); } });
  await instance.initialize(context().ctx);
  const pull = instance.startPull();
  expect(instance.startPull()).toBe(pull);
  expect(instance.snapshot()).toMatchObject({ state: "pulling", percent: 60 });
  await expect(instance.restart()).rejects.toThrow("No prepared update");
  await expect(instance.setReleaseChannel("latest")).rejects.toThrow("in progress");
  gate.resolve(); await pull;
  expect(instance.snapshot().state).toBe("ready_to_restart");
  await instance.restart();
  expect(requests).toEqual(["sha256:prepared-image-id"]);
  expect(instance.snapshot().state).toBe("restarting");
  await expect(instance.restart()).rejects.toThrow("already in progress");
});
test("preparation failure keeps the old app running and offers a retry", async () => {
  let attempts = 0;
  const instance = manager({ prepareUpdate: async (reference) => {
    if (++attempts === 1) throw new Error("workspace image unavailable");
    return { reference, imageId: "sha256:prepared" };
  }, requestUpdate: async () => { throw new Error("must not restart while preparing"); } });
  await instance.initialize(context().ctx);
  await instance.startPull();
  expect(instance.snapshot()).toMatchObject({ state: "failed", error: "workspace image unavailable" });
  await expect(instance.restart()).rejects.toThrow("No prepared update");
  await instance.startPull();
  expect(instance.snapshot()).toMatchObject({ state: "ready_to_restart", error: undefined });
});
test("supervisor failure keeps prepared image available for retry", async () => {
  let requests = 0;
  const instance = manager({ requestUpdate: async () => { if (++requests === 1) throw new Error("supervisor busy"); } });
  await instance.initialize(context().ctx); await instance.startPull();
  await expect(instance.restart()).rejects.toThrow("supervisor busy");
  expect(instance.snapshot()).toMatchObject({ state: "ready_to_restart", error: "supervisor busy" });
  await instance.restart();
  expect(requests).toBe(2);
});
test("restart route acknowledges same-origin reload only after supervisor acceptance", async () => {
  const accepted = deferred();
  const instance = manager({ requestUpdate: async () => accepted.promise });
  await instance.initialize(context().ctx); await instance.startPull();
  const route = createUpdateRouteHandler(instance);
  const url = new URL("https://atelier.example/update/restart?surface=settings");
  const pending = route(new Request(url, { method: "POST" }), url);
  expect(instance.snapshot().state).toBe("restarting");
  accepted.resolve();
  const response = (await pending)!;
  expect(response.status).toBe(204);
  expect(response.headers.get("x-atelier-reload")).toBe("true");
  expect(response.headers.has("location")).toBe(false);
});
test("background checks cannot replace a pinned download or prepared target", async () => {
  const pendingCheck = deferred<{ digest: string }>();
  let checks = 0;
  const instance = manager({ fetchMetadata: async () => ++checks === 1 ? { digest: newDigest } : pendingCheck.promise });
  await instance.initialize(context().ctx);
  const stale = instance.checkNow();
  await instance.startPull();
  pendingCheck.resolve({ digest: newerDigest });
  await stale;
  await instance.checkNow();
  expect(instance.snapshot().target!.digest).toBe(newDigest);
  expect(instance.snapshot().state).toBe("ready_to_restart");
  expect(checks).toBe(2);
});
test("channel changes persist, discard prior prepared images, and survive manager restart", async () => {
  const previous = process.env.ATELIER_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "atelier-update-settings-"));
  process.env.ATELIER_DATA_DIR = directory;
  try {
    const dependencies = { readChannel: readStoredReleaseChannel, writeChannel: writeStoredReleaseChannel };
    const instance = manager(dependencies);
    await instance.initialize(context().ctx); await instance.startPull();
    await instance.setReleaseChannel("latest");
    await expect(instance.restart()).rejects.toThrow("No prepared update");
    const restarted = manager(dependencies);
    await restarted.initialize(context().ctx);
    expect(restarted.snapshot().releaseChannel).toBe("latest");
  } finally {
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR; else process.env.ATELIER_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
test("a superseded channel check cannot publish success or failure", async () => {
  for (const fail of [false, true]) {
    const pending = deferred<{ digest: string }>();
    const instance = manager({ fetchMetadata: async (channel) => channel === "latest" ? pending.promise : { digest: newDigest } });
    await instance.initialize(context().ctx);
    const stale = instance.setReleaseChannel("latest");
    await Bun.sleep(0);
    await instance.setReleaseChannel("stable");
    const snapshot = instance.snapshot();
    if (fail) pending.reject(new Error("registry failed")); else pending.resolve({ digest: newerDigest });
    await stale;
    expect(instance.snapshot()).toEqual(snapshot);
  }
});
test("supervisor protocol sends only immutable image ID and requires acceptance", async () => {
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("http://127.0.0.1:3001/update");
    expect(JSON.parse(String(init!.body))).toEqual({ image: "sha256:prepared" });
    return Response.json({ accepted: true }, { status: 202 });
  });
  await requestSupervisorUpdate("sha256:prepared", fetcher);
  await expect(requestSupervisorUpdate("sha256:prepared", async () => new Response("busy", { status: 409 }))).rejects.toThrow("busy");
});
