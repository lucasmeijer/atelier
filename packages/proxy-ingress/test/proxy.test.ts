import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAtelierRuntimeContextForTests } from "@atelier/core";
import {
  ensureTailscaleServePortConfig,
  ensureWorkspacePublicProxyRoute,
  listWorkspacePublicProxyRoutes,
  publicProxyPortRangeFromEnv,
  releaseWorkspacePublicProxyRoute,
  releaseWorkspacePublicProxyRoutes,
  syncTailscaleServePortConfig,
  type TailscaleServeConfig,
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

describe("Tailscale Serve config", () => {
  test("adds one HTTPS proxy port without disturbing existing stable routes", () => {
    const config: TailscaleServeConfig = {
      TCP: { "443": { HTTPS: true } },
      Web: { "atelier.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000/" } } } },
    };

    expect(ensureTailscaleServePortConfig(config, { host: "atelier.tailnet.ts.net", port: 41000 })).toBe(true);
    expect(config).toEqual({
      TCP: { "443": { HTTPS: true }, "41000": { HTTPS: true } },
      Web: {
        "atelier.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000/" } } },
        "atelier.tailnet.ts.net:41000": { Handlers: { "/": { Proxy: "http://127.0.0.1:41000/" } } },
      },
    });
    expect(ensureTailscaleServePortConfig(config, { host: "atelier.tailnet.ts.net", port: 41000 })).toBe(false);
  });

  test("sync is a no-op when the managed range has no entries", () => {
    const config: TailscaleServeConfig = {
      TCP: { "443": { HTTPS: true } },
      Web: { "atelier.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000/" } } } },
    };

    expect(syncTailscaleServePortConfig(config, { host: "atelier.tailnet.ts.net", activePorts: new Set(), portRange: { start: 41000, end: 41002 } })).toBe(false);
    expect(config).toEqual({
      TCP: { "443": { HTTPS: true } },
      Web: { "atelier.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000/" } } } },
    });
  });

  test("sync keeps active Atelier ports and prunes inactive owned range entries", () => {
    const config: TailscaleServeConfig = {
      TCP: { "443": { HTTPS: true }, "41000": { HTTPS: true }, "41001": { HTTPS: true }, "41002": { TCPForward: "127.0.0.1:41002" } },
      Web: {
        "atelier.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000/" } } },
        "atelier.tailnet.ts.net:41001": { Handlers: { "/": { Proxy: "http://127.0.0.1:41001/" } } },
        "atelier.tailnet.ts.net:41002": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999/" } } },
      },
    };

    expect(syncTailscaleServePortConfig(config, { host: "atelier.tailnet.ts.net", activePorts: new Set([41000]), portRange: { start: 41000, end: 41002 } })).toBe(true);
    expect(config).toEqual({
      TCP: { "443": { HTTPS: true }, "41000": { HTTPS: true }, "41002": { TCPForward: "127.0.0.1:41002" } },
      Web: {
        "atelier.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000/" } } },
        "atelier.tailnet.ts.net:41000": { Handlers: { "/": { Proxy: "http://127.0.0.1:41000/" } } },
        "atelier.tailnet.ts.net:41002": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999/" } } },
      },
    });
  });
});
