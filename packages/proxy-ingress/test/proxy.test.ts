import { gzipSync } from "node:zlib";
import { describe, expect, test } from "bun:test";
import {
  createMemoryOriginIdentityStore,
  createWorkspaceIngress,
  ensureTailscaleServePortConfig,
  normalizeDecodedFetchResponse,
  publicOriginPortRangeFromEnv,
  StoppedWorkspaceError,
  syncTailscaleServePortConfig,
  type OriginPublisher,
  type TailscaleServeConfig,
} from "@atelier/proxy-ingress/server";
import { closeWebSocket } from "../src/ingress/websocket.ts";

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const port = server.port!;
  server.stop(true);
  return port;
}

function recordingPublisher() {
  const active = new Set<number>();
  const calls: string[] = [];
  const publisher: OriginPublisher = {
    async publish(port) { active.add(port); calls.push(`publish:${port}`); },
    async unpublish(port) { active.delete(port); calls.push(`unpublish:${port}`); },
    async reset(ports) {
      active.clear();
      for (const port of ports) active.add(port);
      calls.push(`reset:${[...ports].join(",")}`);
    },
  };
  return { active, calls, publisher };
}

describe("workspace ingress", () => {
  test("does not forward reserved WebSocket close codes", () => {
    const calls: Array<[number?, string?]> = [];
    const socket = { close: (code?: number, reason?: string) => { calls.push([code, reason]); } };

    closeWebSocket(socket, 1005, "No Status Received");
    closeWebSocket(socket, 4001, "upstream done");

    expect(calls).toEqual([[undefined, undefined], [4001, "upstream done"]]);
  });

  test("keeps canonical identity stable while origin leases are ephemeral", async () => {
    const port = await freePort();
    const published = recordingPublisher();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      originPublisher: published.publisher,
      resolveWorkspace: () => undefined,
      resolveApp: (_app, url) => ({ kind: "fetch", fetch: () => new Response(`served:${url.pathname}`) }),
    });
    await ingress.initialize();

    const canonical = new Request("http://127.0.0.1:3000/workspaces/ws/apps/demo/path?x=1");
    const first = await ingress.openCanonical({ workspaceId: "ws", appKey: "demo" }, "/path?x=1", canonical);
    const second = await ingress.openCanonical({ workspaceId: "ws", appKey: "demo" }, "/other", canonical);

    expect(first.status).toBe(302);
    expect(new URL(first.headers.get("location")!).port).toBe(String(port));
    expect(new URL(second.headers.get("location")!).port).toBe(String(port));
    expect(published.calls).toEqual(["reset:", `publish:${port}`]);
    expect(await (await fetch(first.headers.get("location")!)).text()).toBe("served:/path");
    expect(ingress.inspect()).toEqual([expect.objectContaining({ workspaceId: "ws", appKey: "demo", port, scope: "public" })]);

    await ingress.stopWorkspace("ws");
    expect(ingress.inspect()).toEqual([]);
    expect(published.active.size).toBe(0);
    await ingress.stopAll();
  });

  test("never reassigns a retained browser origin to another app", async () => {
    const start = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start, end: start + 1 },
      resolveWorkspace: () => undefined,
      resolveApp: () => ({ kind: "fetch", fetch: () => new Response("ok") }),
    });
    await ingress.initialize();
    const request = new Request("http://127.0.0.1:3000/");
    const first = await ingress.openCanonical({ workspaceId: "ws", appKey: "first" }, "/", request);
    const firstPort = Number(new URL(first.headers.get("location")!).port);
    await ingress.stopWorkspace("ws");
    const second = await ingress.openCanonical({ workspaceId: "ws", appKey: "second" }, "/", request);
    const secondPort = Number(new URL(second.headers.get("location")!).port);
    expect(secondPort).not.toBe(firstPort);
    await ingress.stopWorkspace("ws");
    const reopened = await ingress.openCanonical({ workspaceId: "ws", appKey: "first" }, "/", request);
    expect(Number(new URL(reopened.headers.get("location")!).port)).toBe(firstPort);
    await ingress.stopAll();
  });

  test("streams HTTP requests with consistent local forwarding headers", async () => {
    let observed: { method: string; body: string; host: string | null; proto: string | null } | undefined;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        observed = {
          method: request.method,
          body: await request.text(),
          host: request.headers.get("x-forwarded-host"),
          proto: request.headers.get("x-forwarded-proto"),
        };
        return new Response("upstream", { status: 201, headers: { "x-app": "ok" } });
      },
    });
    const port = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      resolveWorkspace: () => undefined,
      resolveApp: (_app, url) => ({ kind: "http", target: new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${upstream.port}`) }),
    });
    await ingress.initialize();
    const opened = await ingress.openCanonical(
      { workspaceId: "ws", appKey: "demo" },
      "/submit?x=1",
      new Request("https://atelier.example/workspaces/ws/apps/demo/submit?x=1", { headers: { "x-forwarded-proto": "https", host: "atelier.example" } }),
    );
    const location = new URL(opened.headers.get("location")!);
    const response = await fetch(`http://127.0.0.1:${location.port}/submit?x=1`, { method: "POST", body: "payload", headers: { host: location.host } });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-app")).toBe("ok");
    expect(await response.text()).toBe("upstream");
    expect(observed).toEqual({ method: "POST", body: "payload", host: `localhost:${upstream.port}`, proto: "http" });

    await ingress.stopAll();
    upstream.stop(true);
  });

  test("preserves forms, redirects, cookies, validators, downloads, custom headers, and byte ranges", async () => {
    let uploaded = "";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/form") {
          const form = await request.formData();
          // SAFETY: This acceptance request constructs the multipart field with a File below.
          const file = form.get("file") as File;
          uploaded = `${form.get("title")}:${await file.text()}`;
          return new Response("created", { status: 201 });
        }
        if (url.pathname === "/redirect") return new Response(null, { status: 307, headers: { location: "/final?ok=1" } });
        if (url.pathname === "/cookie") return new Response("cookie", { headers: { "set-cookie": "session=abc; Path=/; HttpOnly", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; frame-ancestors 'none'" } });
        if (url.pathname === "/conditional") return request.headers.get("if-none-match") === `"v1"`
          ? new Response(null, { status: 304, headers: { etag: `"v1"`, "x-app-validator": "matched" } })
          : new Response("fresh", { headers: { etag: `"v1"` } });
        if (url.pathname === "/range") return new Response("2345", { status: 206, headers: { "content-range": "bytes 2-5/10", "accept-ranges": "bytes" } });
        if (url.pathname === "/download") return new Response("data", { headers: { "content-disposition": `attachment; filename="report.txt"` } });
        return new Response("not found", { status: 404 });
      },
    });
    const port = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      resolveWorkspace: () => undefined,
      resolveApp: (_app, url) => ({ kind: "http", target: new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${upstream.port}`) }),
    });
    await ingress.initialize();
    const opened = await ingress.openCanonical({ workspaceId: "ws", appKey: "web" }, "/", new Request("http://127.0.0.1:3000/"));
    const origin = new URL(opened.headers.get("location")!).origin;
    const form = new FormData();
    form.set("title", "demo");
    form.set("file", new File(["payload"], "demo.txt"));
    expect((await fetch(`${origin}/form`, { method: "POST", body: form })).status).toBe(201);
    expect(uploaded).toBe("demo:payload");
    const redirect = await fetch(`${origin}/redirect`, { redirect: "manual" });
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe(`${origin}/final?ok=1`);
    const cookie = await fetch(`${origin}/cookie`);
    expect(cookie.headers.get("set-cookie")).toContain("session=abc");
    expect(cookie.headers.get("x-frame-options")).toBeNull();
    expect(cookie.headers.get("content-security-policy")).toBe("default-src 'self'");
    const conditional = await fetch(`${origin}/conditional`, { headers: { "if-none-match": `"v1"` } });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("x-app-validator")).toBe("matched");
    const range = await fetch(`${origin}/range`, { headers: { range: "bytes=2-5" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await range.text()).toBe("2345");
    expect((await fetch(`${origin}/download`)).headers.get("content-disposition")).toContain("attachment");
    await ingress.stopAll();
    upstream.stop(true);
  });

  test("streams server-sent events and propagates response cancellation", async () => {
    let cancelled = false;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: ready\\ndata: 1\\n\\n"));
        },
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "text/event-stream" } }),
    });
    const port = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      resolveWorkspace: () => undefined,
      resolveApp: (_app, url) => ({ kind: "http", target: new URL(url.pathname, `http://127.0.0.1:${upstream.port}`) }),
    });
    await ingress.initialize();
    const opened = await ingress.openCanonical({ workspaceId: "ws", appKey: "events" }, "/events", new Request("http://127.0.0.1:3000/"));
    const response = await fetch(opened.headers.get("location")!);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: ready");
    await reader.cancel("done");
    await Bun.sleep(20);
    expect(cancelled).toBe(true);
    await ingress.stopAll();
    upstream.stop(true);
  });

  test("nested Atelier can lease more than ten app origins", async () => {
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      resolveWorkspace: () => undefined,
      resolveApp: () => ({ kind: "fetch", fetch: () => new Response("nested") }),
    });
    const request = new Request("http://127.0.0.1:3000/", {
      headers: { "x-atelier-parent-origin": "https://outer.example", "x-atelier-parent-workspace": "outer" },
    });
    try {
      for (let index = 0; index < 12; index += 1) {
        const response = await ingress.openCanonical({ workspaceId: "inner", appKey: `app-${index}` }, "/", request);
        expect(response.status).toBe(302);
      }
      const leases = ingress.inspect();
      expect(leases).toHaveLength(12);
      expect(leases.some((lease) => lease.port! > 3010)).toBe(true);
    } finally {
      await ingress.stopAll();
    }
  });

  test("keeps direct and nested origin leases independent", async () => {
    const port = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      resolveWorkspace: () => undefined,
      resolveApp: () => ({ kind: "fetch", fetch: () => new Response("nested") }),
    });
    await ingress.initialize();
    const app = { workspaceId: "inner", appKey: "browser-1" };
    const direct = await ingress.openCanonical(app, "/direct", new Request("http://127.0.0.1:3000/workspaces/inner/apps/browser-1/direct"));
    const nested = await ingress.openCanonical(app, "/nested?x=1", new Request("http://127.0.0.1:3000/workspaces/inner/apps/browser-1/nested?x=1", {
      headers: {
        "x-atelier-parent-origin": "https://outer.example",
        "x-atelier-parent-workspace": "outer",
      },
    }));

    expect(new URL(direct.headers.get("location")!).port).toBe(String(port));
    const nestedLocation = new URL(nested.headers.get("location")!);
    expect(nestedLocation.origin).toBe("https://outer.example");
    expect(nestedLocation.pathname).toMatch(/^\/workspaces\/outer\/ports\/30(?:0[1-9]|10)\/nested$/);
    expect(nestedLocation.search).toBe("?x=1");
    expect(nested.headers.get("x-atelier-nested-workspace-proxy-redirect")).toBe("1");
    expect(ingress.inspect().map((lease) => lease.scope).sort()).toEqual(["nested", "public"]);
    await ingress.stopAll();
  });

  test("bridges text and binary WebSockets with subprotocol and clean closure propagation", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const offered = request.headers.get("sec-websocket-protocol")?.split(",").map((value) => value.trim()) ?? [];
        const headers = offered.includes("atelier-test") ? { "sec-websocket-protocol": "atelier-test" } : undefined;
        if (server.upgrade(request, { headers })) return undefined;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(socket, message) {
          if (message === "close-cleanly") socket.close(4001, "upstream done");
          else socket.send(message);
        },
      },
    });
    const port = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      resolveWorkspace: () => undefined,
      resolveApp: (_app, url) => ({ kind: "http", target: new URL(url.pathname, `http://127.0.0.1:${upstream.port}`) }),
    });
    await ingress.initialize();
    const opened = await ingress.openCanonical(
      { workspaceId: "ws", appKey: "socket" },
      "/echo",
      new Request("http://127.0.0.1:3000/workspaces/ws/apps/socket/echo"),
    );
    const location = new URL(opened.headers.get("location")!);
    location.protocol = "ws:";
    const result = await new Promise<{ protocol: string; binary: number[]; closeCode: number; closeReason: string }>((resolve, reject) => {
      const socket = new WebSocket(location, ["atelier-test"]);
      socket.binaryType = "arraybuffer";
      const timer = setTimeout(() => reject(new Error("WebSocket bridge timed out")), 2_000);
      let protocol = "";
      let binary: number[] = [];
      socket.addEventListener("open", () => {
        protocol = socket.protocol;
        socket.send(new Uint8Array([1, 2, 3]));
      });
      socket.addEventListener("message", (event) => {
        // SAFETY: binaryType is set to arraybuffer before the socket opens.
        binary = [...new Uint8Array(event.data as ArrayBuffer)];
        socket.send("close-cleanly");
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        resolve({ protocol, binary, closeCode: event.code, closeReason: event.reason });
      });
      socket.addEventListener("error", () => reject(new Error("WebSocket bridge failed")));
    });
    expect(result).toEqual({ protocol: "atelier-test", binary: [1, 2, 3], closeCode: 4001, closeReason: "upstream done" });
    await ingress.stopAll();
    upstream.stop(true);
  });

  test("supports the 10-workspace, 10-app, 100-concurrent-connection baseline", async () => {
    const identities = createMemoryOriginIdentityStore();
    const assigned = new Set<number>();
    for (let workspace = 0; workspace < 10; workspace += 1) {
      for (let app = 0; app < 10; app += 1) {
        assigned.add((await identities.assignedPort({ workspaceId: `ws-${workspace}`, appKey: `app-${app}` }, "public", { start: 46000, end: 46099 })).port);
      }
    }
    expect(assigned.size).toBe(100);

    let arrived = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const port = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      resolveWorkspace: () => undefined,
      resolveApp: () => ({
        kind: "fetch",
        async fetch() {
          arrived += 1;
          await gate;
          return new Response("ok");
        },
      }),
    });
    await ingress.initialize();
    const opened = await ingress.openCanonical({ workspaceId: "ws", appKey: "app" }, "/", new Request("http://127.0.0.1:3000/"));
    const location = opened.headers.get("location")!;
    const responsePromises = Array.from({ length: 100 }, () => fetch(location));
    for (let attempt = 0; arrived < 100 && attempt < 100; attempt += 1) await Bun.sleep(10);
    expect(arrived).toBe(100);
    expect(ingress.inspect()[0]!.activeConnections).toBe(100);
    release?.();
    const responses = await Promise.all(responsePromises);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await Promise.all(responses.map((response) => response.text()));
    await ingress.stopAll();
  }, 15_000);

  test("distinguishes stopped workspaces and origin capacity exhaustion", async () => {
    const stoppedPort = await freePort();
    const stopped = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: stoppedPort, end: stoppedPort },
      resolveWorkspace: () => { throw new StoppedWorkspaceError("parked"); },
      resolveApp: () => ({ kind: "fetch", fetch: () => new Response("ok") }),
    });
    await stopped.initialize();
    const stoppedResponse = await stopped.openCanonical({ workspaceId: "parked", appKey: "demo" }, "/", new Request("http://127.0.0.1:3000/"));
    expect(stoppedResponse.status).toBe(503);
    expect(await stoppedResponse.text()).toContain("Start the workspace");
    await stopped.stopAll();

    const capacityPort = await freePort();
    const capacity = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: capacityPort, end: capacityPort },
      resolveWorkspace: () => undefined,
      resolveApp: () => ({ kind: "fetch", fetch: () => new Response("ok") }),
    });
    await capacity.initialize();
    await capacity.openCanonical({ workspaceId: "ws", appKey: "first" }, "/", new Request("http://127.0.0.1:3000/"));
    await capacity.stopWorkspace("ws");
    const exhausted = await capacity.openCanonical({ workspaceId: "ws", appKey: "second" }, "/", new Request("http://127.0.0.1:3000/"));
    expect(exhausted.status).toBe(507);
    expect(await exhausted.text()).toContain("capacity exhausted");
    await capacity.stopAll();
  });

  test("distinguishes missing apps without allocating an origin", async () => {
    const port = await freePort();
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1",
      originPortRange: { start: port, end: port },
      resolveWorkspace: () => undefined,
      resolveApp: () => undefined,
    });
    await ingress.initialize();
    const response = await ingress.openCanonical(
      { workspaceId: "ws", appKey: "missing" },
      "/",
      new Request("http://127.0.0.1:3000/workspaces/ws/apps/missing/"),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("does not exist");
    expect(ingress.inspect()).toEqual([expect.objectContaining({ appKey: "missing", failureCategory: "unknown_app", targetState: "failed" })]);
    await ingress.stopAll();
  });
});

describe("decoded upstream response normalization", () => {
  test("removes metadata for a transparently decoded representation", async () => {
    const compressed = gzipSync("decoded JavaScript");
    const upstream = Bun.serve({
      port: 0,
      fetch: () => new Response(compressed, { headers: { "content-encoding": "gzip", "content-length": String(compressed.byteLength), etag: "\"encoded\"" } }),
    });
    const response = await fetch(`http://localhost:${upstream.port}`);
    upstream.stop();
    const normalized = normalizeDecodedFetchResponse(response);
    expect(await normalized.text()).toBe("decoded JavaScript");
    expect(normalized.headers.get("content-encoding")).toBeNull();
    expect(normalized.headers.get("content-length")).toBeNull();
    expect(normalized.headers.get("etag")).toBeNull();
  });
});

describe("origin publication policy", () => {
  test("parses configured origin port ranges", () => {
    expect(publicOriginPortRangeFromEnv("43100-43110")).toEqual({ start: 43100, end: 43110 });
    expect(() => publicOriginPortRangeFromEnv("bad")).toThrow();
  });

  test("publishes active HTTPS origins without disturbing unrelated routes", () => {
    const config: TailscaleServeConfig = {
      TCP: { "443": { HTTPS: true } },
      Web: { "atelier.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000/" } } } },
    };
    expect(ensureTailscaleServePortConfig(config, { host: "atelier.tailnet.ts.net", port: 41000 })).toBe(true);
    expect(syncTailscaleServePortConfig(config, {
      host: "atelier.tailnet.ts.net",
      activePorts: new Set<number>(),
      portRange: { start: 41000, end: 41000 },
    })).toBe(true);
    expect(config).toEqual({
      TCP: { "443": { HTTPS: true } },
      Web: { "atelier.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000/" } } } },
    });
  });
});
