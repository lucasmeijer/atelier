import { expect, test } from "bun:test";
import { createWorkspaceIngress } from "../src/ingress/index.ts";

// Protocol coverage, not browser UI: two real ingress hops and an origin-checking app.
test("nested previews translate same-origin POST/preflight/socket requests one hop at a time", async () => {
  const observed: Headers[] = [];
  const app = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server): Promise<Response | undefined> {
      observed.push(new Headers(request.headers));
      const origin = request.headers.get("origin");
      if (origin !== `http://${request.headers.get("x-forwarded-host")}` || origin !== `http://localhost:${server.port}`) return new Response("foreign origin", { status: 403 });
      if (new URL(request.url).pathname === "/redirect") return new Response(null, { status: 307, headers: { location: `http://localhost:${server.port}/next?x=1` } });
      if (request.headers.get("upgrade") === "websocket") {
        if (server.upgrade(request)) return;
        throw new Error("upgrade failed");
      }
      return new Response(request.method === "OPTIONS" ? null : await request.text(), {
        headers: { "access-control-allow-origin": origin, "timing-allow-origin": origin, "access-control-allow-credentials": "true" },
      });
    },
    websocket: { message(socket, message) { socket.send(message); } },
  });
  const inner = createWorkspaceIngress({
    hostname: "127.0.0.1", resolveWorkspace: () => undefined,
    resolveApp: (_app, url) => ({ kind: "http", target: new URL(`http://127.0.0.1:${app.port}${url.pathname}`) }),
  });
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  let nestedPort: number;
  const outer = createWorkspaceIngress({
    hostname: "127.0.0.1", originPortRange: { start: port, end: port }, resolveWorkspace: () => undefined,
    resolveApp: (_app, url) => ({ kind: "http", target: new URL(`http://127.0.0.1:${nestedPort}${url.pathname}`) }),
  });
  const publicOrigin = `https://preview.example:${port}`;
  const headers = { host: `preview.example:${port}`, "x-forwarded-proto": "https", origin: publicOrigin };
  try {
    await inner.initialize();
    await outer.initialize();
    await inner.openCanonical({ workspaceId: "inner", appKey: "app" }, "/", new Request("http://127.0.0.1:3000/", {
      headers: { "x-atelier-parent-origin": "https://atelier.example", "x-atelier-parent-workspace": "outer" },
    }));
    nestedPort = inner.inspect()[0]!.port!;
    await outer.openCanonical({ workspaceId: "outer", appKey: "app" }, "/", new Request("https://preview.example:3000/"));
    const target = `http://127.0.0.1:${port}`;
    for (const method of ["POST", "OPTIONS"]) {
      const response = await fetch(target, { method, headers, body: method === "POST" ? "form" : undefined });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(publicOrigin);
      expect(response.headers.get("timing-allow-origin")).toBe(publicOrigin);
      expect(response.headers.get("vary")).toBe("Origin");
      expect(await response.text()).toBe(method === "POST" ? "form" : "");
    }
    // SAFETY: Bun supports an options constructor omitted by the DOM declarations.
    const Socket = WebSocket as typeof WebSocket & (new (url: string, options: Bun.WebSocketOptions) => WebSocket);
    const socket = new Socket(target.replace("http:", "ws:"), { headers, proxy: "" });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket timeout")); }, 4000);
      socket.onopen = () => socket.send("reload");
      socket.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket failed")); };
      socket.onmessage = (event) => { expect(event.data).toBe("reload"); clearTimeout(timer); socket.close(); resolve(); };
    });
    expect(observed).toHaveLength(3);
    for (const request of observed) {
      expect(request.get("origin")).toBe(`http://localhost:${app.port}`);
      expect(request.get("x-forwarded-host")).toBe(`localhost:${app.port}`);
      expect(request.get("x-atelier-public-origin")).toBe(publicOrigin);
    }
    const redirect = await fetch(`${target}/redirect`, { headers, redirect: "manual" });
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe(`${publicOrigin}/next?x=1`);
    await redirect.text();
    for (const origin of ["https://evil.example", "null", `http://localhost:${nestedPort}`]) {
      const before = observed.length;
      const response = await fetch(target, { method: "POST", headers: {
        ...headers, origin,
        "x-atelier-public-origin": "https://evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", "x-atelier-origin-context": origin,
      }, body: "foreign" });
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("foreign origin");
      expect(observed).toHaveLength(before + 1);
      expect(observed.at(-1)!.get("origin")).toBe(origin);
    }
  } finally {
    await outer.stopAll();
    await inner.stopAll();
    app.stop(true);
  }
});
