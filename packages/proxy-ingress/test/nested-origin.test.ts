import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connect, createServer } from "node:net";
import { workspaceGatewayPortHeader, workspaceGatewayHostHeader, workspaceGatewayProtocolHeader, workspaceGatewayTokenHeader } from "@atelier/shared";
import { createParentAtelierPublisher } from "../src/ingress/index.ts";
import { startIngress } from "./fixtures/ingress.ts";

function freePort() { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = server.port!; server.stop(true); return port; }
async function gateway(identity: string) {
  function target(headers: Record<string, string | string[] | undefined>) {
    if (headers[workspaceGatewayTokenHeader] !== identity) throw new Error("incorrect gateway identity");
    const port = Number(headers[workspaceGatewayPortHeader]);
    headers.host = String(headers[workspaceGatewayHostHeader]);
    for (const key of [workspaceGatewayPortHeader, workspaceGatewayHostHeader, workspaceGatewayProtocolHeader, workspaceGatewayTokenHeader]) delete headers[key];
    return port;
  }
  const connections = new Set<import("node:net").Socket>();
  const server = createServer((downstream) => {
    connections.add(downstream);
    downstream.on("close", () => connections.delete(downstream));
    let input = Buffer.alloc(0);
    function read(chunk: Buffer) {
      input = Buffer.concat([input, chunk]);
      const end = input.indexOf("\r\n\r\n");
      if (end < 0) return;
      downstream.pause();
      downstream.off("data", read);
      const [first, ...lines] = input.subarray(0, end).toString().split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines) { const colon = line.indexOf(":"); headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim(); }
      const port = target(headers);
      if (!headers.upgrade) headers.connection = "close";
      const upstream = connect(port, "127.0.0.1", () => {
        upstream.write(`${first}\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
        upstream.write(input.subarray(end + 4));
        downstream.pipe(upstream); upstream.pipe(downstream); downstream.resume();
      });
      upstream.on("error", () => downstream.destroy());
      downstream.on("error", () => upstream.destroy());
      downstream.on("close", () => upstream.destroy());
    }
    downstream.on("data", read);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing gateway address");
  return { url: new URL(`http://127.0.0.1:${address.port}`), stop() { for (const socket of connections) socket.destroy(); server.close(); } };
}
async function socketRequest(socket: string, input: unknown) {
  return await fetch("http://localhost/origins", { unix: socket, method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } });
}

test("nested socket publication routes HTTP and WebSocket directly, retains origins across both restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ingress-"));
  const outerGateway = await gateway("o1234");
  const innerGateway = await gateway("i4321");
  const foreignGateway = await gateway("other");
  const observed: Headers[] = [];
  const dev = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      observed.push(new Headers(request.headers));
      const origin = request.headers.get("origin");
      if (origin && origin !== `http://localhost:${server.port}`) return new Response("foreign", { status: 403 });
      if (request.headers.get("upgrade") === "websocket") { if (server.upgrade(request)) return; throw new Error("upgrade failed"); }
      if (new URL(request.url).pathname === "/redirect") return new Response(null, { status: 307, headers: { location: `http://localhost:${server.port}/products?sort=true`, "set-cookie": "session=ok; Domain=localhost; HttpOnly" } });
      return new Response(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search} ${await request.text()}`, { headers: origin ? { "access-control-allow-origin": origin, "timing-allow-origin": origin } : {} });
    }, websocket: { message(socket, message) { socket.send(message); } },
  });
  const published: number[] = [];
  const parent = { kind: "tailscale" as const, async publish(port: number) { published.push(port); return `https://atelier.example:${port}`; } };
  const outerPort = freePort(), innerPort = freePort();
  let outer = await startIngress(join(directory, "outer"), outerPort, parent, { o1234: outerGateway.url, other: foreignGateway.url });
  let inner = await startIngress(join(directory, "inner"), innerPort, createParentAtelierPublisher(outer.socket("o1234")), { i4321: innerGateway.url });
  try {
    const origins = await Promise.all(Array.from({ length: 12 }, () => inner.ingress.publishPort("i4321", dev.port!)));
    expect(new Set(origins).size).toBe(1);
    const origin = origins[0]!;
    expect(published).toHaveLength(1);
    expect(outer.ingress.inspect()[0]!.workspaceId).toBe("o1234");
    const actual = origin.replace("https://atelier.example", "http://127.0.0.1");
    const headers = { origin };
    const response = await fetch(`${actual}/products?sort=true&x=a%20b`, { method: "POST", headers, body: "payload=one&two=2" });
    expect(await response.text()).toBe("POST /products?sort=true&x=a%20b payload=one&two=2");
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("timing-allow-origin")).toBe(origin);
    const redirect = await fetch(`${actual}/redirect`, { headers, redirect: "manual" });
    expect(redirect.headers.get("location")).toBe(`${origin}/products?sort=true`);
    expect(redirect.headers.get("set-cookie")).toBe("session=ok; HttpOnly");
    await redirect.text();
    const Socket = WebSocket as typeof WebSocket & (new (url: string, options: Bun.WebSocketOptions) => WebSocket);
    const socket = new Socket(actual.replace("http:", "ws:") + "/live?x=1", { headers, proxy: "" });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket timeout")); }, 3000);
      socket.onopen = () => socket.send("reload");
      socket.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket failed")); };
      socket.onmessage = (event) => { expect(event.data).toBe("reload"); clearTimeout(timer); socket.close(); resolve(); };
    });
    for (const foreign of ["https://evil.example", "null", `http://localhost:${innerPort}`]) {
      const response = await fetch(actual, { method: "POST", body: "bad", headers: { origin: foreign, "x-atelier-origin-context": foreign, "x-atelier-public-origin": foreign } });
      expect(response.status).toBe(403); await response.text();
      expect(observed.at(-1)!.get("origin")).toBe(foreign);
    }
    const rejected = await socketRequest(outer.socket("o1234"), { port: dev.port, workspaceId: "other" });
    expect(rejected.status).toBe(400); await rejected.text();
    const another = await socketRequest(outer.socket("other"), { port: innerPort, protocol: "http" });
    expect(another.status).toBe(200);
    expect((await another.json() as { origin: string }).origin).not.toBe(origin);
    const invalid = await socketRequest(outer.socket("other"), { port: 0 });
    expect(invalid.status).toBe(400); await invalid.text();
    await inner.stop(); await outer.stop();
    outer = await startIngress(join(directory, "outer"), outerPort, parent, { o1234: outerGateway.url, other: foreignGateway.url });
    inner = await startIngress(join(directory, "inner"), innerPort, createParentAtelierPublisher(outer.socket("o1234")), { i4321: innerGateway.url });
    // No navigate/publication request: restored listeners immediately serve traffic.
    expect(await (await fetch(`${actual}/restored?x=2`)).text()).toBe("GET /restored?x=2 ");
    expect(await inner.ingress.publishPort("i4321", dev.port!)).toBe(origin);
  } finally {
    await inner.stop(); await outer.stop(); dev.stop(true);
    outerGateway.stop(); innerGateway.stop(); foreignGateway.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
