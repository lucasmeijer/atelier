import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAtelierRuntimeContextForTests } from "@atelier/core";
import {
  createWorkspaceIngressProxy,
  ensureTailscaleServePortConfig,
  ensureWorkspacePublicProxyRoute,
  listWorkspacePublicProxyRoutes,
  publicProxyPortRangeFromEnv,
  releaseWorkspacePublicProxyRoute,
  releaseWorkspacePublicProxyRoutes,
  syncTailscaleServePortConfig,
  type TailscaleServeConfig,
  normalizeDecodedFetchResponse,
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

describe("decoded upstream response normalization", () => {
  test("removes compression metadata from a transparently decoded response", async () => {
    const compressed = gzipSync("decoded JavaScript");
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(compressed, {
          headers: {
            "content-encoding": "gzip",
            "content-length": String(compressed.byteLength),
            "content-md5": "encoded-md5",
            "content-digest": "sha-256=:encoded:",
            "repr-digest": "sha-256=:encoded:",
            etag: "\"encoded-representation\"",
            vary: "Accept-Encoding",
          },
        });
      },
    });
    const response = await fetch(`http://localhost:${upstream.port}`);
    upstream.stop();

    // Bun fetch has decoded the gzip bytes while preserving these headers.
    expect(await response.clone().text()).toBe("decoded JavaScript");
    expect(response.headers.get("content-encoding")).toBe("gzip");
    const normalized = normalizeDecodedFetchResponse(response);
    expect(await normalized.text()).toBe("decoded JavaScript");
    expect(normalized.headers.get("content-encoding")).toBeNull();
    expect(normalized.headers.get("content-length")).toBeNull();
    expect(normalized.headers.get("content-md5")).toBeNull();
    expect(normalized.headers.get("content-digest")).toBeNull();
    expect(normalized.headers.get("repr-digest")).toBeNull();
    expect(normalized.headers.get("etag")).toBeNull();
    expect(normalized.headers.get("vary")).toBe("Accept-Encoding");
  });

  test("passes through an unencoded response without changing its byte validator", async () => {
    const response = new Response("plain JavaScript", {
      headers: { "content-length": "16", etag: "\"plain-representation\"" },
    });

    expect(normalizeDecodedFetchResponse(response)).toBe(response);
    expect(await response.text()).toBe("plain JavaScript");
    expect(response.headers.get("etag")).toBe("\"plain-representation\"");
  });

  test("keeps weak validators, which remain valid across content codings", () => {
    const response = new Response("decoded", {
      headers: { "content-encoding": "br", etag: "W/\"semantic-version\"" },
    });

    expect(normalizeDecodedFetchResponse(response).headers.get("etag")).toBe("W/\"semantic-version\"");
  });
});

describe("workspace public proxy route state", () => {
  test("exposes nested routes through the outer Atelier workspace", async () => {
    const exposedPorts = new Set<number>();
    const proxy = createWorkspaceIngressProxy({
      hostname: "127.0.0.1",
      publicPortRange: { start: 43100, end: 43102 },
      publicPortExposer: {
        ensurePort: (port) => { exposedPorts.add(port); return Promise.resolve(); },
        releasePort: (port) => { exposedPorts.delete(port); return Promise.resolve(); },
        syncPorts: () => Promise.resolve(),
      },
      resolveWorkspace: () => undefined,
      listWorkspaceIds: () => [],
      resolveTarget: () => new URL("http://127.0.0.1:3000"),
    });
    const standardResponse = await proxy.redirectToRoute(
      "inner",
      "browser-1",
      "/demo?x=1",
      new Request("http://127.0.0.1:3000/workspaces/inner/apps/browser-1/"),
    );
    expect(standardResponse.headers.get("location")).toBe("http://127.0.0.1:43100/demo?x=1");
    expect(exposedPorts).toEqual(new Set([43100]));

    const nestedRequest = new Request("http://127.0.0.1:3000/workspaces/inner/apps/browser-1/", {
      headers: {
        "x-atelier-parent-origin": "https://outer.example",
        "x-atelier-parent-workspace": "outer-workspace",
      },
    });
    const response = await proxy.redirectToRoute("inner", "browser-1", "/demo?x=1", nestedRequest);

    expect(response.status).toBe(302);
    const routes = await listWorkspacePublicProxyRoutes(["inner"]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ workspaceId: "inner", appKey: "browser-1" });
    expect(routes[0]!.publicPort).toBeGreaterThanOrEqual(3001);
    expect(routes[0]!.publicPort).toBeLessThanOrEqual(3010);
    expect(response.headers.get("location")).toBe(`https://outer.example/workspaces/outer-workspace/ports/${routes[0]!.publicPort}/demo?x=1`);
    expect(exposedPorts).toEqual(new Set());
    await proxy.stopAll();
  });

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
