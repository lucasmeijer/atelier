import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTailscaleParentPublisher } from "../src/ingress/parent.ts";

test("Tailscale parent starts before login, fails publication clearly, and works after login without restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "parent-tailscale-"));
  const socket = join(directory, "tailscaled.sock");
  let dnsName = "";
  let disconnected = false;
  let requests = 0;
  let config: any = { TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } }, Web: {} };
  const server = createServer(async (req, res) => {
    requests++;
    if (req.url === "/localapi/v0/status") { res.end(JSON.stringify({ BackendState: disconnected ? "Stopped" : dnsName ? "Running" : "NeedsLogin", Self: { DNSName: dnsName } })); return; }
    if (req.method === "GET") { res.setHeader("etag", '"1"'); res.end(JSON.stringify(config)); return; }
    expect(req.headers["if-match"]).toBe('"1"');
    let body = ""; for await (const chunk of req) body += chunk;
    config = JSON.parse(body); res.end();
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const parent = createTailscaleParentPublisher(socket, { start: 42000, end: 42999 });
    expect(parent.kind).toBe("tailscale");
    expect(requests).toBe(0);
    await expect(parent.publish(42001)).rejects.toThrow("connect Tailscale before publishing a preview");
    expect(config.Web).toEqual({});
    dnsName = "atelier.example.ts.net.";
    expect(await parent.publish(42001)).toBe("https://atelier.example.ts.net:42001");
    expect(config.Web["atelier.example.ts.net:42001"].Handlers["/"].Proxy).toBe("http://127.0.0.1:42001/");
    await parent.unpublish!(42001);
    expect(config.TCP["42001"]).toBeUndefined();
    expect(config.TCP["443"]).toEqual({ HTTPS: true });
    expect(config.TCP["8443"]).toEqual({ HTTPS: true });
    disconnected = true;
    await expect(parent.publish(42001)).rejects.toThrow("connect Tailscale before publishing a preview");
  } finally {
    server.closeAllConnections(); server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a configured unavailable Tailscale socket never falls back to localhost", async () => {
  const parent = createTailscaleParentPublisher(`/tmp/missing-tailscale-${crypto.randomUUID()}.sock`);
  await expect(parent.publish(41001)).rejects.toThrow();
  expect(parent.kind).toBe("tailscale");
});

test("System mode is queried for each origin without relying on Tailscale socket presence", async () => {
  const { createSystemOriginPublisher } = await import("../src/ingress/parent.ts");
  let port = 53000;
  const publisher = createSystemOriginPublisher(undefined, (async () => Response.json({ mode: "localhost", localPort: port })));
  expect(await publisher.publish(41001)).toBe("http://p41001.atelier.localhost:53000");
  port = 53001;
  expect(await publisher.publish(41001)).toBe("http://p41001.atelier.localhost:53001");
  expect(publisher.refresh).toBe(true);
});
