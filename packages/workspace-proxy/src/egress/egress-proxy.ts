import dns from "node:dns/promises";
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rmdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import tls from "node:tls";
import { HttpRequestBlockedError } from "@atelier/core";
import { createWorkspaceSecretContext, forgetWorkspaceSecretContext, getWorkspaceSecretContext } from "@atelier/core";
import { atelierDataPath, dockerHostAtelierDataPath, getAtelierRuntimeContext } from "@atelier/core";
import type { AtelierEventBus } from "@atelier/core";
import { ensureLeafCertificate, ensureMitmCa, type MitmCa } from "./mitm-ca.ts";

export const atelierWorkspaceProxyPort = 58123;
export type AtelierWorkspaceProxy = { port: number; close(): Promise<void> };

const workspaceMitmCaPath = "/run/atelier-mitm-ca.crt";

const proxyAuthVersion = 1;
let sharedProxy: Promise<AtelierWorkspaceProxy> | undefined;
let proxyAuthFileLock: Promise<void> = Promise.resolve();
const mitmTargetServers = new Map<string, Promise<MitmTargetServer>>();

type ProxyAuthFile = { version: number; workspaces: Record<string, { token: string }> };
type MitmConnectionContext = { workspaceId: string; hostname: string };
type MitmTargetServer = { server: ReturnType<typeof createHttpsServer>; port: number; connections: Map<number, MitmConnectionContext> };

export function workspaceProxyHost(): string {
  return process.env.ATELIER_WORKSPACE_PROXY_HOST || "host.docker.internal";
}

export function workspaceProxyUrl(workspaceId: string, token: string): string {
  return `http://${encodeURIComponent(workspaceId)}:${encodeURIComponent(token)}@${workspaceProxyHost()}:${atelierWorkspaceProxyPort}`;
}

function workspaceProxyEnv(workspaceId: string, token: string): Record<string, string> {
  const proxy = workspaceProxyUrl(workspaceId, token);
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
    CURL_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
    NODE_EXTRA_CA_CERTS: "/usr/local/share/ca-certificates/atelier-mitm-ca.crt",
    GIT_SSL_CAINFO: "/etc/ssl/certs/ca-certificates.crt",
    NPM_CONFIG_CAFILE: "/etc/ssl/certs/ca-certificates.crt",
    YARN_CA_FILE: "/etc/ssl/certs/ca-certificates.crt",
    PIP_CERT: "/etc/ssl/certs/ca-certificates.crt",
  };
}

export function registerWorkspaceProxyEvents(events: AtelierEventBus): void {
  events.on("workspace_plan_prepare", async ({ workspaceId, plan }) => {
    const runtimeContext = await getAtelierRuntimeContext();
    const secretContext = await createWorkspaceSecretContext(workspaceId);
    Object.assign(plan.env, secretContext.env);

    const proxyAuthToken = await ensureWorkspaceProxyAuthToken(workspaceId);
    await ensureAtelierWorkspaceProxy();
    await ensureMitmCa(runtimeContext);
    Object.assign(plan.env, workspaceProxyEnv(workspaceId, proxyAuthToken));
    plan.mounts.push({ type: "bind", source: dockerHostAtelierDataPath(runtimeContext, "proxy-ca", "atelier-mitm-ca.pem"), target: workspaceMitmCaPath, readonly: true });
    plan.initScripts.push(`if [ -r ${workspaceMitmCaPath} ]; then mkdir -p /usr/local/share/ca-certificates; cp ${workspaceMitmCaPath} /usr/local/share/ca-certificates/atelier-mitm-ca.crt; update-ca-certificates || true; fi`);
    plan.initScripts.push(`cat > /usr/local/bin/atelier-git-credential <<'EOF'
#!/bin/sh
test "$1" = get || exit 0
[ -n "\${GH_TOKEN:-}" ] || exit 0
echo username=x-access-token
echo password="$GH_TOKEN"
EOF
chmod 755 /usr/local/bin/atelier-git-credential; cat > /etc/profile.d/atelier-github-token.sh <<'EOF'
# GH_TOKEN, when present, is an Atelier placeholder. It is not the real secret.
EOF
git config --file /home/atelier/.gitconfig user.name 'Lucas Meijer'; git config --file /home/atelier/.gitconfig user.email lucas@lucasmeijer.com; git config --file /home/atelier/.gitconfig credential.helper '!/usr/local/bin/atelier-git-credential'; git config --file /home/atelier/.gitconfig http.proxy "$HTTPS_PROXY"; git config --file /home/atelier/.gitconfig http.proxyAuthMethod basic; chown atelier:atelier /home/atelier/.gitconfig`);
    plan.cleanup.push(async () => cleanupWorkspaceProxy(workspaceId));
  });

  events.on("workspace_deleted", async ({ workspaceId }) => cleanupWorkspaceProxy(workspaceId));
}

async function cleanupWorkspaceProxy(workspaceId: string): Promise<void> {
  await forgetWorkspaceProxyAuthToken(workspaceId).catch(() => undefined);
  forgetWorkspaceSecretContext(workspaceId);
}

export async function ensureAtelierWorkspaceProxy(): Promise<AtelierWorkspaceProxy> {
  if (sharedProxy) return sharedProxy;
  sharedProxy = startAtelierWorkspaceProxy().catch((error) => {
    sharedProxy = undefined;
    throw error;
  });
  return sharedProxy;
}

export async function stopAtelierWorkspaceProxy(): Promise<void> {
  const proxy = await sharedProxy?.catch(() => undefined);
  sharedProxy = undefined;
  await proxy?.close();
  await closeMitmTargetServers();
}

export async function ensureWorkspaceProxyAuthToken(workspaceId: string): Promise<string> {
  return await updateProxyAuthFile((file) => {
    const existing = file.workspaces[workspaceId]?.token;
    if (existing) return existing;
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    file.workspaces[workspaceId] = { token };
    return token;
  });
}

export async function forgetWorkspaceProxyAuthToken(workspaceId: string): Promise<void> {
  await updateProxyAuthFile((file) => {
    delete file.workspaces[workspaceId];
  });
}

async function startAtelierWorkspaceProxy(): Promise<AtelierWorkspaceProxy> {
  const ca = await ensureMitmCa();
  const server = createServer((req, res) => void handleProxyHttpRequest(req, res).catch((error) => writeError(res, error)));
  server.on("connect", (req, socket, head) => void handleConnect(ca, req, socket as net.Socket, head).catch((error) => {
    const netSocket = socket as net.Socket;
    netSocket.write(connectErrorResponse(error));
    netSocket.destroy();
  }));
  const ownsServer = await new Promise<boolean>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(atelierWorkspaceProxyPort, "0.0.0.0");
  });
  if (!ownsServer) return { port: atelierWorkspaceProxyPort, close: async () => {} };
  server.unref();
  return { port: atelierWorkspaceProxyPort, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function handleProxyHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const workspaceId = await authenticateProxyRequest(req);
  await handleProxyHttp(workspaceId, req, res);
}

async function handleConnect(ca: MitmCa, req: IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
  const workspaceId = await authenticateProxyRequest(req);
  const { hostname, port } = parseConnectTarget(req.url || "");
  if (port !== 443) throw new HttpRequestBlockedError("CONNECT only allowed to port 443");
  await assertDestinationAllowed(workspaceId, hostname, port, "https");
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

  const targetServer = await ensureMitmTargetServer(ca, hostname);
  const bridge = net.connect(targetServer.port, "127.0.0.1", () => {
    const localPort = bridge.localPort;
    if (localPort) targetServer.connections.set(localPort, { workspaceId, hostname });
    if (head.length) bridge.write(head);
  });
  socket.pipe(bridge).pipe(socket);
  const cleanup = () => {
    const localPort = bridge.localPort;
    if (localPort) targetServer.connections.delete(localPort);
  };
  socket.once("close", cleanup);
  bridge.once("close", cleanup);
}

async function ensureMitmTargetServer(ca: MitmCa, hostname: string): Promise<MitmTargetServer> {
  const key = hostname.toLowerCase();
  const existing = mitmTargetServers.get(key);
  if (existing) return existing;
  const created = startMitmTargetServer(ca, hostname).catch((error) => {
    mitmTargetServers.delete(key);
    throw error;
  });
  mitmTargetServers.set(key, created);
  return created;
}

async function startMitmTargetServer(ca: MitmCa, hostname: string): Promise<MitmTargetServer> {
  const leaf = await ensureLeafCertificate(ca, hostname);
  const connections = new Map<number, MitmConnectionContext>();
  const server = createHttpsServer({
    cert: readFileSync(leaf.certPath),
    key: readFileSync(leaf.keyPath),
    ALPNProtocols: ["http/1.1"],
  }, (mitmReq, mitmRes) => {
    const remotePort = (mitmReq.socket as net.Socket).remotePort;
    const context = remotePort ? connections.get(remotePort) : undefined;
    if (!context) {
      writeError(mitmRes, new HttpRequestBlockedError("unknown MITM connection"));
      return;
    }
    const path = mitmReq.url || "/";
    mitmReq.url = `https://${context.hostname}${path.startsWith("/") ? path : `/${path}`}`;
    void handleProxyHttp(context.workspaceId, mitmReq, mitmRes).catch((error) => writeError(mitmRes, error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  server.unref();
  const address = server.address();
  const serverPort = typeof address === "object" && address ? address.port : 0;
  return { server, port: serverPort, connections };
}

async function closeMitmTargetServers(): Promise<void> {
  const servers = await Promise.all(Array.from(mitmTargetServers.values()).map((server) => server.catch(() => undefined)));
  mitmTargetServers.clear();
  await Promise.all(servers.filter((server): server is MitmTargetServer => Boolean(server)).map((target) => new Promise<void>((resolve) => target.server.close(() => resolve()))));
}

async function handleProxyHttp(workspaceId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const targetUrl = requestTargetUrl(req);
  const parsed = new URL(targetUrl);
  const protocol = parsed.protocol === "https:" ? "https" : "http";
  const port = parsed.port ? Number(parsed.port) : protocol === "https" ? 443 : 80;
  await assertDestinationAllowed(workspaceId, parsed.hostname, port, protocol);

  const method = (req.method || "GET").toUpperCase();
  const canHaveBody = !["GET", "HEAD"].includes(method);
  const request = new Request(parsed.toString(), {
    method: req.method,
    headers: incomingHeaders(req),
    body: canHaveBody ? Readable.toWeb(req) as any : undefined,
    ...(canHaveBody ? ({ duplex: "half" } as const) : {}),
  });

  const context = await getWorkspaceSecretContext(workspaceId);
  const hooks = context?.hooks;
  let next: Request | Response = request;
  if (hooks?.onRequest) {
    const updated = await hooks.onRequest(request);
    if (updated) next = updated;
  }
  if (next instanceof Response) return await writeFetchResponse(res, next);
  if (hooks?.isRequestAllowed && !(await hooks.isRequestAllowed(new Request(next.url, { method: next.method, headers: next.headers })))) throw new HttpRequestBlockedError("request blocked by policy");

  const upstream = await fetch(next.url, {
    method: next.method,
    headers: filteredForwardHeaders(next.headers),
    body: ["GET", "HEAD"].includes(next.method.toUpperCase()) ? undefined : next.body,
    redirect: "manual",
    ...(!["GET", "HEAD"].includes(next.method.toUpperCase()) ? ({ duplex: "half" } as const) : {}),
  });
  const finalResponse = hooks?.onResponse ? await hooks.onResponse(upstream, next) ?? upstream : upstream;
  await writeFetchResponse(res, finalResponse);
}

async function authenticateProxyRequest(req: IncomingMessage): Promise<string> {
  const header = req.headers["proxy-authorization"];
  const value = Array.isArray(header) ? header[0] : header;
  const credentials = decodeProxyBasicAuth(value ?? "");
  if (!credentials) throw new HttpRequestBlockedError("proxy authentication required", 407, "Proxy Authentication Required");
  const file = await readProxyAuthFile();
  const expected = file.workspaces[credentials.username]?.token;
  if (!expected || !timingSafeEqual(credentials.password, expected)) throw new HttpRequestBlockedError("invalid proxy authentication", 407, "Proxy Authentication Required");
  return credentials.username;
}

function decodeProxyBasicAuth(value: string): { username: string; password: string } | undefined {
  const match = value.match(/^Basic\s+(\S+)$/i);
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return undefined;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return nodeTimingSafeEqual(left, right);
}

async function assertDestinationAllowed(workspaceId: string, hostname: string, port: number, protocol: "http" | "https"): Promise<void> {
  const context = await getWorkspaceSecretContext(workspaceId);
  const hooks = context?.hooks;
  if (!hooks?.isIpAllowed) return;
  const addresses = await dns.lookup(hostname, { all: true, verbatim: false });
  if (addresses.length === 0) throw new HttpRequestBlockedError(`could not resolve host: ${hostname}`);
  for (const address of addresses) {
    const family = address.family === 6 ? 6 : 4;
    if (!(await hooks.isIpAllowed({ hostname, ip: address.address, family, port, protocol }))) throw new HttpRequestBlockedError(`destination not allowed: ${hostname}`);
  }
}

function requestTargetUrl(req: IncomingMessage): string {
  const raw = req.url || "/";
  if (/^https?:\/\//i.test(raw)) return raw;
  const host = req.headers.host;
  if (!host) throw new HttpRequestBlockedError("missing Host header");
  const encrypted = req.socket instanceof tls.TLSSocket;
  return `${encrypted ? "https" : "http"}://${host}${raw.startsWith("/") ? raw : `/${raw}`}`;
}

function parseConnectTarget(target: string): { hostname: string; port: number } {
  const match = target.match(/^\[([^\]]+)\]:(\d+)$/) || target.match(/^([^:]+):(\d+)$/);
  if (!match) throw new HttpRequestBlockedError(`invalid CONNECT target: ${target}`);
  return { hostname: match[1]!.toLowerCase(), port: Number(match[2]) };
}

function incomingHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (/^(proxy-authorization|proxy-connection)$/i.test(name)) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v); else headers.set(name, value);
  }
  return headers;
}

function filteredForwardHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]) out.delete(name);
  return out;
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  response.headers.forEach((value, key) => {
    if (/^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|content-length)$/i.test(key)) return;
    res.setHeader(key, value);
  });
  if (!response.body) { res.end(); return; }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as any).on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
  });
}

function writeError(res: ServerResponse, error: unknown): void {
  const status = error instanceof HttpRequestBlockedError ? error.status : 502;
  const statusText = error instanceof HttpRequestBlockedError ? error.statusText : "Bad Gateway";
  const headers: Record<string, string> = { "content-type": "text/plain" };
  if (status === 407) headers["proxy-authenticate"] = "Basic realm=\"Atelier Workspace Proxy\"";
  res.writeHead(status, statusText, headers);
  res.end(`${safeErrorMessage(error)}\n`);
}

function connectErrorResponse(error: unknown): string {
  const status = error instanceof HttpRequestBlockedError ? error.status : 502;
  const statusText = error instanceof HttpRequestBlockedError ? error.statusText : "Bad Gateway";
  const headers = [
    `HTTP/1.1 ${status} ${statusText}`,
    "Connection: close",
    "Content-Type: text/plain",
  ];
  if (status === 407) headers.push("Proxy-Authenticate: Basic realm=\"Atelier Workspace Proxy\"");
  return `${headers.join("\r\n")}\r\n\r\n${safeErrorMessage(error)}\n`;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof HttpRequestBlockedError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

async function updateProxyAuthFile<T>(update: (file: ProxyAuthFile) => T): Promise<T> {
  const previous = proxyAuthFileLock;
  let releaseProcessLock!: () => void;
  proxyAuthFileLock = new Promise<void>((resolve) => { releaseProcessLock = resolve; });
  await previous;

  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    const filePath = await proxyAuthFilePath();
    releaseFileLock = await acquireProxyAuthFileLock(filePath);
    const file = await readProxyAuthFileAt(filePath);
    const result = update(file);
    await writeProxyAuthFileAt(filePath, file);
    return result;
  } finally {
    await releaseFileLock?.();
    releaseProcessLock();
  }
}

async function readProxyAuthFile(): Promise<ProxyAuthFile> {
  return await readProxyAuthFileAt(await proxyAuthFilePath());
}

async function readProxyAuthFileAt(path: string): Promise<ProxyAuthFile> {
  if (!existsSync(path)) return { version: proxyAuthVersion, workspaces: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ProxyAuthFile;
    if (parsed.version === proxyAuthVersion && parsed.workspaces && typeof parsed.workspaces === "object") return parsed;
  } catch {}
  return { version: proxyAuthVersion, workspaces: {} };
}

async function writeProxyAuthFileAt(path: string, file: ProxyAuthFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

async function acquireProxyAuthFileLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockDir = `${path}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      return async () => { await rmdir(lockDir).catch(() => {}); };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`timed out waiting for proxy auth lock: ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function proxyAuthFilePath(): Promise<string> {
  const context = await getAtelierRuntimeContext();
  return atelierDataPath(context, "proxy", "workspace-auth.json");
}
