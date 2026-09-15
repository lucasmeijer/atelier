import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { createParentAtelierPublisher, createWorkspaceIngress, mutateTailscaleServeConfig, ensureTailscaleServePortConfig } from "../src/ingress/index.ts";

test("Serve CAS retries a concurrent supervisor write and keeps 443 and diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "serve-"));
  const socketPath = join(directory, "tailscale.sock");
  let revision = 1;
  let writes = 0;
  let config: any = { TCP: { "443": { HTTPS: true } }, Web: { "atelier.example:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } };
  const server = createServer(async (req, res) => {
    if (req.method === "GET") { res.setHeader("etag", `"${revision}"`); res.end(JSON.stringify(config)); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    writes++;
    if (writes === 1) {
      config.TCP["8443"] = { HTTPS: true };
      config.Web["atelier.example:8443"] = { Handlers: { "/": { Proxy: "http://127.0.0.1:3001" } } };
      revision++;
    }
    if (req.headers["if-match"] !== `"${revision}"`) { res.writeHead(412); res.end(); return; }
    config = JSON.parse(body); revision++; res.end();
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await mutateTailscaleServeConfig(socketPath, (state) => ensureTailscaleServePortConfig(state, { host: "atelier.example", port: 42001 }));
    expect(writes).toBe(2);
    expect(config.Web["atelier.example:443"].Handlers["/"].Proxy).toBe("http://127.0.0.1:3000");
    expect(config.Web["atelier.example:8443"].Handlers["/"].Proxy).toBe("http://127.0.0.1:3001");
    expect(config.Web["atelier.example:42001"].Handlers["/"].Proxy).toBe("http://127.0.0.1:42001/");
  } finally { server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an unavailable configured parent fails publication, never returns a localhost fallback", async () => {
  const ingress = createWorkspaceIngress({ hostname: "127.0.0.1", parentOriginPublisher: createParentAtelierPublisher(`/tmp/missing-ingress-${crypto.randomUUID()}.sock`), resolveWorkspace() {}, resolveApp() { return undefined; } });
  try { await expect(ingress.publishPort("workspace", 8080)).rejects.toThrow(); expect(ingress.inspect()).toHaveLength(0); }
  finally { await ingress.stopAll(); }
});

test("publication configures routing without contacting the target, and rejects a conflicting protocol", async () => {
  const ingress = createWorkspaceIngress({ hostname: "127.0.0.1", resolveWorkspace() {}, resolveApp() { throw new Error("must not contact target during publication"); } });
  try {
    expect(await ingress.publishPort("workspace", 8080)).toStartWith("http://localhost:");
    await expect(ingress.publishPort("workspace", 8080, "https")).rejects.toThrow("different protocol");
  } finally { await ingress.stopAll(); }
});

test("a publication arriving while the parent is still working waits for the final origin", async () => {
  let started!: () => void;
  let finish!: () => void;
  const starting = new Promise<void>((resolve) => { started = resolve; });
  const finishing = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  const ingress = createWorkspaceIngress({ hostname: "127.0.0.1", resolveWorkspace() {}, resolveApp() { return undefined; }, parentOriginPublisher: { kind: "tailscale", async publish(port) { calls++; started(); await finishing; return `https://atelier.example:${port}`; } } });
  try {
    const first = ingress.publishPort("workspace", 8080);
    await starting;
    const later = ingress.publishPort("workspace", 8080);
    finish();
    const [a, b] = await Promise.all([first, later]);
    expect(a).toBe(b); expect(a).toStartWith("https://atelier.example:"); expect(calls).toBe(1);
  } finally { await ingress.stopAll(); }
});

test("changing System mode republishes existing listener without closing old routes", async () => {
  let mode = "local";
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { return Response.json({ origin: request.headers.get("origin") }); } });
  const ingress = createWorkspaceIngress({
    hostname: "127.0.0.1", resolveWorkspace() {},
    resolveApp() { return { kind: "http", target: new URL(`http://localhost:${backend.port}`) }; },
    parentOriginPublisher: { kind: "system", refresh: true, async publish(port) { return mode === "local" ? `http://p${port}.atelier.localhost:55000` : `https://atelier.example:${port}`; } },
  });
  try {
    const first = await ingress.publishPort("workspace", 8080);
    mode = "remote";
    const second = await ingress.publishPort("workspace", 8080);
    expect(first).not.toBe(second);
    expect(ingress.inspect()).toHaveLength(1);
    const port = new URL(second).port;
    for (const origin of [first, second]) {
      const response = await fetch(`http://127.0.0.1:${port}`, { headers: { host: new URL(origin).host, origin } });
      expect(await response.json()).toEqual({ origin: `http://localhost:${backend.port}` });
    }
  } finally { await ingress.stopAll(); backend.stop(true); }
});
