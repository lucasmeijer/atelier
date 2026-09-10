import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import net from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceLocalProxyConfig, workspaceLocalProxyInitScript, workspaceLocalProxyUrl } from "../src/egress/local-proxy.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0; });

test("workspace proxy startup uses a credential-free loopback URL and a separate upstream configuration", () => {
  expect(workspaceLocalProxyUrl).toBe("http://127.0.0.1:58124");
  const upstream = { host: "172.17.0.1", port: 58123, username: "workspace", password: "token" };
  const script = workspaceLocalProxyInitScript(upstream);
  expect(script).toContain("Upstream http workspace:token@172.17.0.1:58123");
  expect(script).toContain("Listen 127.0.0.1");
  expect(script).toContain("/usr/local/bin/atelier-egress-proxy -d -c /run/atelier-proxy/tinyproxy.conf");
  expect(script).toContain('grep -Fq "pid=$proxy_pid,"');
});

// This is a protocol integration test against the workspace-image binary.
// It does not need Docker, external networking, or a browser.
test.skipIf(!Bun.which("atelier-egress-proxy"))("local forwarder authenticates HTTP and CONNECT upstream, not at the client", async () => {
  const seen: { method: string; authorization: string | undefined; url: string | undefined }[] = [];
  const uploads: { authorization: string | undefined; body: string }[] = [];
  const upstream = createServer((req, res) => {
    seen.push({ method: req.method!, authorization: req.headers["proxy-authorization"], url: req.url });
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      if (req.method === "POST") uploads.push({ authorization: req.headers.authorization, body });
      res.statusCode = req.url?.endsWith("/blocked") ? 403 : 200;
      res.end(res.statusCode === 403 ? "blocked by upstream" : "forwarded");
    });
  });
  upstream.on("connect", (req, socket, head) => {
    seen.push({ method: req.method!, authorization: req.headers["proxy-authorization"], url: req.url });
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  // SAFETY: Listening on a TCP port produces AddressInfo, not a Unix socket path.
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  // SAFETY: Listening on a TCP port produces AddressInfo, not a Unix socket path.
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const dir = await mkdtemp(join(tmpdir(), "atelier-local-proxy-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config = workspaceLocalProxyConfig({ host: "127.0.0.1", port: upstreamPort, username: "workspace", password: "token" })
    .replace(`Port ${new URL(workspaceLocalProxyUrl).port}`, `Port ${port}`);
  await writeFile(join(dir, "tinyproxy.conf"), config);
  const process = Bun.spawn(["atelier-egress-proxy", "-d", "-c", join(dir, "tinyproxy.conf")], { stdout: "pipe", stderr: "pipe" });
  cleanup.push(async () => { process.kill(); await process.exited; });
  const logs = new Response(process.stderr).text();
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); resolve(); });
        socket.once("error", reject);
      });
      break;
    } catch (error) {
      if (process.exitCode !== null) throw new Error(await logs);
      if (attempt === 99) throw error;
      await Bun.sleep(20);
    }
  }
  for (const authorization of [undefined, "Basic forged-client-credentials"]) {
    const response = await fetch("http://destination.invalid/resource", {
      proxy: `http://127.0.0.1:${port}`,
      headers: authorization ? { "Proxy-Authorization": authorization } : {},
    });
    expect(await response.text()).toBe("forwarded");
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(`CONNECT destination.invalid:443 HTTP/1.1\r\nHost: destination.invalid:443\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}\r\n`);
      });
      socket.on("error", reject);
      socket.setTimeout(3000, () => socket.destroy(new Error("CONNECT timed out")));
      let received = "";
      let established = false;
      socket.on("data", (data) => {
        received += data.toString();
        if (!established && received.includes("\r\n\r\n")) {
          if (!received.startsWith("HTTP/1.1 200")) { socket.destroy(new Error(received)); return; }
          established = true;
          received = "";
          socket.write("tunnel payload");
        } else if (established && received === "tunnel payload") {
          socket.destroy(); resolve();
        }
      });
    });
  }
  expect(seen).toEqual(["GET", "CONNECT", "GET", "CONNECT"].map((method) => ({
    method,
    authorization: `Basic ${Buffer.from("workspace:token").toString("base64")}`,
    url: method === "GET" ? "http://destination.invalid:80/resource" : "destination.invalid:443",
  })));
  const upload = await fetch("http://destination.invalid/upload", {
    proxy: `http://127.0.0.1:${port}`,
    method: "POST",
    headers: { Authorization: "Bearer secret-placeholder" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("streamed body")); controller.close(); } }),
  });
  expect(await upload.text()).toBe("forwarded");
  expect(uploads).toEqual([{ authorization: "Bearer secret-placeholder", body: "streamed body" }]);
  const blocked = await fetch("http://destination.invalid/blocked", { proxy: `http://127.0.0.1:${port}` });
  expect(blocked.status).toBe(403);
  expect(await blocked.text()).toBe("blocked by upstream");
}, 15000);
