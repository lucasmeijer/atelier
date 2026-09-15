import { afterEach, expect, test } from "bun:test";
import { createServer, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net from "node:net";
import tls from "node:tls";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startWorkspaceEgressProxy } from "../src/egress/egress-proxy.ts";
import { ensureMitmCa, ensureLeafCertificate } from "../src/egress/mitm-ca.ts";
import { createHttpHooks } from "../src/secrets/placeholder-hooks.ts";
import type { WorkspaceSecretContext } from "../src/secrets/workspace-secrets.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0; });

async function listen(server: net.Server) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  // SAFETY: The listen callback completed on an IP address, so address() is a TCP AddressInfo.
  return (server.address() as net.AddressInfo).port;
}
async function localRelay(socketPath: string): Promise<number> {
  // Run the same standalone module with Node, exactly as the workspace does.
  const source = fileURLToPath(new URL("../rootfs/usr/local/lib/atelier-egress-proxy.mjs", import.meta.url));
  const child = spawn("node", ["--input-type=module", "-e", `
    const { createLocalProxy } = await import(process.argv[2]);
    const { server } = createLocalProxy(process.argv[3]);
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  `, "test-relay", source, socketPath], { stdio: ["ignore", "pipe", "pipe"] });
  cleanup.push(async () => { child.kill(); await new Promise(resolve => child.once("close", resolve)); });
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.stderr.on("data", data => reject(new Error(data.toString())));
    child.stdout.once("data", data => resolve(Number(data.toString().trim())));
    child.once("exit", code => reject(new Error(`Local proxy exited ${code}`)));
  });
}

async function tunnel(proxyPort: number, target: string, headers = "") {
  const socket = net.connect(proxyPort, "127.0.0.1");
  return await new Promise<{ socket: net.Socket; response: string }>((resolve, reject) => {
    socket.once("error", reject);
    socket.setTimeout(5000, () => socket.destroy(new Error("CONNECT timeout")));
    socket.once("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${headers}\r\n`));
    let response = "";
    function received(data: Buffer) {
      response += data.toString();
      if (response.includes("\r\n\r\n")) { socket.off("data", received); socket.off("error", reject); resolve({ socket, response }); }
    }
    socket.on("data", received);
  });
}

// Real HTTP, CONNECT, TLS termination, placeholder injection and outgoing fetch;
// no Docker, registry, browser or external network required.
test("workspace socket controls HTTP and HTTPS identity, policy and reconnection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atelier-egress-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const ca = await ensureMitmCa({ atelierDataDir: directory, dockerHostAtelierDataDir: directory, dockerBridgeHost: "127.0.0.1" });
  const leaf = await ensureLeafCertificate(ca, "127.0.0.1");
  const caPem = await readFile(ca.certPath, "utf8");
  const received: { key?: string | string[]; authorization?: string; proxyAuthorization?: string | string[]; body: string }[] = [];
  const handler: RequestListener = (req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk.toString());
    req.on("end", () => { received.push({ key: req.headers["x-api-key"], authorization: req.headers.authorization, proxyAuthorization: req.headers["proxy-authorization"], body }); res.end("destination response"); });
  };
  const destination = createServer(handler);
  const httpPort = await listen(destination);
  cleanup.push(async () => { destination.closeAllConnections(); await new Promise<void>(resolve => destination.close(() => resolve())); });
  const secureDestination = createHttpsServer({ cert: await readFile(leaf.certPath), key: await readFile(leaf.keyPath) }, handler);
  const httpsPort = await listen(secureDestination);
  cleanup.push(async () => { secureDestination.closeAllConnections(); await new Promise<void>(resolve => secureDestination.close(() => resolve())); });
  const contexts = new Map<string, WorkspaceSecretContext>();
  for (const workspaceId of ["alpha", "beta"]) {
    const hooks = createHttpHooks({
      allowedInternalHosts: ["127.0.0.1", "localhost"],
      secrets: { API_KEY: { value: `${workspaceId}-secret`, placeholder: "ATELIER_TEST_PLACEHOLDER", hosts: ["127.0.0.1", "localhost"] } },
    });
    contexts.set(workspaceId, { workspaceId, env: hooks.env, hooks: hooks.httpHooks, secrets: hooks.secrets });
  }
  // Route logical TLS port443 to an ephemeral local fixture, trusting its test CA.
  // Requests still use the real upstream fetch and the proxy's real HTTP hooks.
  const upstreamFetch = (url: string, init: RequestInit) => {
    const target = new URL(url);
    if (target.protocol === "https:" && !target.port) { target.hostname = "127.0.0.1"; target.port = String(httpsPort); }
    return fetch(target, { ...init, tls: { ca: caPem } });
  };
  const start = (id: string) => startWorkspaceEgressProxy({ socketPath: join(directory, id, "egress.sock"), ca, getContext: async () => contexts.get(id)!, upstreamFetch });
  let alpha = await start("alpha");
  const beta = await start("beta");
  cleanup.push(() => alpha.close()); cleanup.push(() => beta.close());
  const alphaPort = await localRelay(join(directory, "alpha", "egress.sock"));
  const betaPort = await localRelay(join(directory, "beta", "egress.sock"));
  const headers = { "X-Api-Key": "ATELIER_TEST_PLACEHOLDER", Authorization: "Bearer destination-authorization", "Proxy-Authorization": `Basic ${Buffer.from("beta:forged-token").toString("base64")}`, "X-Workspace-Id": "beta" };
  for (const [id, port] of [["alpha", alphaPort], ["beta", betaPort]] as const) {
    const response = await fetch(`http://127.0.0.1:${httpPort}/upload`, { proxy: `http://127.0.0.1:${port}`, method: "POST", headers, body: "streamed payload" });
    expect(await response.text()).toBe("destination response");
    expect(received.at(-1)).toEqual({ key: `${id}-secret`, authorization: "Bearer destination-authorization", proxyAuthorization: undefined, body: "streamed payload" });
  }
  const connected = await tunnel(alphaPort, "localhost:443", `Proxy-Authorization: ${headers["Proxy-Authorization"]}\r\nX-Workspace-Id: beta\r\n`);
  expect(connected.response).toContain("200 Connection Established");
  const secure = tls.connect({ socket: connected.socket, servername: "localhost", ca: caPem, rejectUnauthorized: true });
  const response = await new Promise<string>((resolve, reject) => {
    let body = "";
    secure.on("error", reject);
    secure.on("data", data => body += data.toString());
    secure.on("end", () => resolve(body));
    secure.once("secureConnect", () => secure.write(`GET /secure HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nX-Api-Key: ATELIER_TEST_PLACEHOLDER\r\nAuthorization: Bearer destination-authorization\r\nProxy-Authorization: forged\r\n\r\n`));
  });
  secure.destroy();
  expect(response).toContain("destination response");
  expect(received.at(-1)).toEqual({ key: "alpha-secret", authorization: "Bearer destination-authorization", proxyAuthorization: undefined, body: "" });
  // Hosts without selected secrets retain opaque CONNECT tunnelling.
  const withoutSecrets = createHttpHooks({ allowedInternalHosts: ["127.0.0.1"] });
  contexts.set("beta", { workspaceId: "beta", env: {}, hooks: withoutSecrets.httpHooks, secrets: [] });
  const plain = await tunnel(betaPort, `127.0.0.1:${httpPort}`);
  expect(plain.response).toContain("200 Connection Established");
  const tunneled = await new Promise<string>((resolve, reject) => {
    let body = "";
    plain.socket.on("error", reject);
    plain.socket.on("data", data => body += data.toString());
    plain.socket.on("end", () => resolve(body));
    plain.socket.write(`GET /tunnel HTTP/1.1\r\nHost: 127.0.0.1:${httpPort}\r\nConnection: close\r\nAuthorization: Bearer destination-authorization\r\n\r\n`);
  });
  plain.socket.destroy();
  expect(tunneled).toContain("destination response");
  expect(received.at(-1)?.authorization).toBe("Bearer destination-authorization");
  const beforeBlocked = received.length;
  expect((await fetch("http://127.0.0.2/private", { proxy: `http://127.0.0.1:${alphaPort}` })).status).toBe(403);
  const blocked = await tunnel(alphaPort, "127.0.0.2:443");
  expect(blocked.response).toContain("403"); blocked.socket.destroy();
  expect(received.length).toBe(beforeBlocked);
  // Restart only the application-side listener. The workspace relay stays up.
  await alpha.close(); alpha = await start("alpha");
  const reconnected = await fetch(`http://127.0.0.1:${httpPort}/after-restart`, { proxy: `http://127.0.0.1:${alphaPort}`, headers });
  expect(await reconnected.text()).toBe("destination response");
  expect(received.at(-1)?.key).toBe("alpha-secret");
}, 20000);
