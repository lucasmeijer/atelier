import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAtelierRuntimeContextForTests } from "@atelier/core";
import {
  ensureWorkspacePublicProxyRoute,
  listWorkspacePublicProxyRoutes,
  publicProxyPortRangeFromEnv,
  releaseWorkspacePublicProxyRoute,
  releaseWorkspacePublicProxyRoutes,
} from "@atelier/proxy-ingress/server";

let dataDir = "";
let previousDataDir: string | undefined;
let previousRange: string | undefined;

beforeEach(async () => {
  previousDataDir = process.env.ATELIER_DATA_DIR;
  previousRange = process.env.ATELIER_PROXY_PORT_RANGE;
  dataDir = await mkdtemp(join(tmpdir(), "atelier-proxy-test-"));
  process.env.ATELIER_DATA_DIR = dataDir;
  delete process.env.ATELIER_PROXY_PORT_RANGE;
  resetAtelierRuntimeContextForTests();
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previousDataDir;
  if (previousRange === undefined) delete process.env.ATELIER_PROXY_PORT_RANGE;
  else process.env.ATELIER_PROXY_PORT_RANGE = previousRange;
  resetAtelierRuntimeContextForTests();
  await rm(dataDir, { recursive: true, force: true });
});

describe("workspace public proxy route state", () => {
  test("parses configured port ranges", () => {
    expect(publicProxyPortRangeFromEnv("43100-43110")).toEqual({ start: 43100, end: 43110 });
    expect(() => publicProxyPortRangeFromEnv("bad")).toThrow();
  });

  test("allocates stable per-workspace app ports and persists minimal state", async () => {
    const range = { start: 43100, end: 43102 };
    expect(await ensureWorkspacePublicProxyRoute("ws1", "vscode", { range })).toEqual({ appKey: "vscode", publicPort: 43100 });
    expect(await ensureWorkspacePublicProxyRoute("ws1", "vscode", { range })).toEqual({ appKey: "vscode", publicPort: 43100 });
    expect(await ensureWorkspacePublicProxyRoute("ws1", "port-3000", { range })).toEqual({ appKey: "port-3000", publicPort: 43101 });

    expect(await listWorkspacePublicProxyRoutes(["ws1"])).toEqual([
      { workspaceId: "ws1", appKey: "vscode", publicPort: 43100 },
      { workspaceId: "ws1", appKey: "port-3000", publicPort: 43101 },
    ]);
  });

  test("allocates different ports across workspaces", async () => {
    const range = { start: 43100, end: 43102 };
    expect((await ensureWorkspacePublicProxyRoute("ws1", "vscode", { range })).publicPort).toBe(43100);
    expect((await ensureWorkspacePublicProxyRoute("ws2", "vscode", { range })).publicPort).toBe(43101);
    expect(await listWorkspacePublicProxyRoutes()).toEqual([
      { workspaceId: "ws1", appKey: "vscode", publicPort: 43100 },
      { workspaceId: "ws2", appKey: "vscode", publicPort: 43101 },
    ]);
  });

  test("can reserve unavailable ports and release all workspace routes", async () => {
    const range = { start: 43100, end: 43102 };
    expect(await ensureWorkspacePublicProxyRoute("ws1", "vscode", { range, reservedPorts: [43100] })).toEqual({ appKey: "vscode", publicPort: 43101 });
    expect(await releaseWorkspacePublicProxyRoute("ws1", "missing")).toBeUndefined();
    expect(await releaseWorkspacePublicProxyRoute("ws1", "vscode")).toBe(43101);
    expect(await listWorkspacePublicProxyRoutes(["ws1"])).toEqual([]);

    expect(await ensureWorkspacePublicProxyRoute("ws1", "vscode", { range })).toEqual({ appKey: "vscode", publicPort: 43100 });
    expect(await releaseWorkspacePublicProxyRoutes("ws1")).toEqual([43100]);
    expect(await listWorkspacePublicProxyRoutes(["ws1"])).toEqual([]);
  });
});
