import { expect, test } from "bun:test";
import { localTarget } from "./local-ingress.ts";

test("local host routing exposes only app, diagnostics, and preview listener range", () => {
  expect(localTarget("atelier.localhost:55123", 3000)).toBe(3000);
  expect(localTarget("atelier.localhost:55123", 3001)).toBe(3001);
  expect(localTarget("system.atelier.localhost:55123", 3000)).toBe(3001);
  expect(localTarget("p41001.atelier.localhost:55123", 3000)).toBe(41001);
  for (const host of ["localhost", "p2375.atelier.localhost", "p42000.atelier.localhost", "p41001.atelier.localhost.evil.com", "evil.com"]) expect(localTarget(host, 3000)).toBeUndefined();
});

test("local routing preserves HTTP cookies and WebSocket traffic", async () => {
  const { startLocalIngress } = await import("./local-ingress.ts");
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(request.headers.get("host"), { headers: { "set-cookie": "preview=1; SameSite=Lax" } });
    }, websocket: { message(socket, message) { socket.send(message); } },
  });
  const proxy = startLocalIngress(() => backend.port!, 0);
  const address = { port: proxy.port };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`, { headers: { host: `atelier.localhost:${address.port}` } });
    expect(await response.text()).toBe(`atelier.localhost:${address.port}`);
    expect(response.headers.get("set-cookie")).toBe("preview=1; SameSite=Lax");
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/`, { headers: { host: `atelier.localhost:${address.port}` } });
      socket.onopen = () => socket.send("hello");
      socket.onmessage = event => { expect(event.data).toBe("hello"); socket.close(); resolve(); };
      socket.onerror = reject;
    });
  } finally { proxy.stop(true); backend.stop(true); }
});
