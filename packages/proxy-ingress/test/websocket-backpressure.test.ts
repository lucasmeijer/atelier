import { expect, test } from "bun:test";
import { forwardToUpstream, maxSocketBufferedBytes } from "../src/ingress/websocket.ts";

test("forwards binary stream bytes unchanged", () => {
  const payload = new Uint8Array([0, 128, 255]).buffer;
  const sent: unknown[] = [];
  forwardToUpstream({ bufferedAmount: 0, send: (value) => { sent.push(value); }, close: () => { throw new Error("unexpected close"); } }, { close: () => { throw new Error("unexpected close"); } }, payload);
  expect(sent).toEqual([payload]);
});

test("closes both sides rather than lose bytes or grow an unbounded input queue", () => {
  const codes: number[] = [];
  const close = (code?: number) => { codes.push(code!); };
  forwardToUpstream({ bufferedAmount: maxSocketBufferedBytes - 1, send: () => { throw new Error("must not enqueue"); }, close }, { close }, "é");
  expect(codes).toEqual([1013, 1013]);
});

test("a stalled downstream closes the real ingress stream and releases its upstream", async () => {
  const { createConnection } = await import("node:net");
  const { createWorkspaceIngress } = await import("../src/ingress/index.ts");
  let producer: ReturnType<typeof setInterval> | undefined;
  let upstreamClosed = false;
  const app = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("upgrade required", { status: 400 }); },
    websocket: {
      open(socket) {
        const chunk = new Uint8Array(256 * 1024);
        producer = setInterval(() => { socket.send(chunk); }, 1);
      },
      message() {},
      close() { clearInterval(producer); upstreamClosed = true; },
    },
  });
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const ingress = createWorkspaceIngress({ hostname: "127.0.0.1", originPortRange: { start: port, end: port }, resolveWorkspace() {}, resolveApp: () => ({ kind: "http", target: new URL(app.url) }) });
  const opened = await ingress.openCanonical({ workspaceId: "slow", appKey: "desktop" }, "/", new Request("http://localhost:3000/"));
  const url = new URL(opened.headers.get("location")!);
  const socket = createConnection({ host: "127.0.0.1", port: Number(url.port) });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
      socket.once("data", () => { socket.pause(); resolve(); });
    });
    const deadline = Date.now() + 4000;
    while (!upstreamClosed && Date.now() < deadline) await Bun.sleep(20);
    expect(upstreamClosed).toBe(true);
  } finally {
    socket.destroy();
    clearInterval(producer);
    await ingress.stopAll();
    app.stop(true);
  }
}, 6000);
