import dns from "node:dns/promises";
import { readFileSync } from "node:fs";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net, { type AddressInfo } from "node:net";
import { Readable, type Duplex } from "node:stream";
import tls from "node:tls";
import { atelierDataPath, dockerHostAtelierDataPath, getAtelierRuntimeContext, shellQuote } from "@atelier/core";
import { HttpRequestBlockedError } from "../secrets/errors.ts";
import { matchHostname } from "../secrets/patterns.ts";
import { createWorkspaceSecretContext, forgetWorkspaceSecretContext, getWorkspaceSecretContext, type WorkspaceSecretContext } from "../secrets/workspace-secrets.ts";
import type { AtelierEventBus } from "@atelier/core";
import { isHopByHopHeader, stripHopByHopHeaders } from "@atelier/shared";
import { workspaceLocalProxyInitScript, workspaceLocalProxyUrl } from "./local-proxy.ts";
import { defaultNoProxyEntries, uniqueNoProxyEntries } from "./no-proxy.ts";
import { ensureLeafCertificate, ensureMitmCa, type MitmCa } from "./mitm-ca.ts";

const workspaceMitmCaPath = "/run/atelier-mitm-ca.crt";

const workspaceProxies = new Map<string, Promise<WorkspaceEgressProxy>>();
type SecretContext = () => Promise<WorkspaceSecretContext>;
type FetchUpstream = (url: string, init: RequestInit) => Promise<Response>;
type ProxyContext = { secrets: SecretContext; fetch: FetchUpstream };
export type WorkspaceEgressProxy = { close(): Promise<void> };
const mitmTargetServers = new Map<string, Promise<MitmTargetServer>>();

type MitmConnectionContext = { context: ProxyContext; hostname: string };
type MitmTargetServer = { server: ReturnType<typeof createHttpsServer>; port: number; connections: Map<number, MitmConnectionContext>; renewAt: number };

function workspaceProxyEnv() {
  const proxy = workspaceLocalProxyUrl;
  const noProxy = uniqueNoProxyEntries(defaultNoProxyEntries()).join(",");
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
    CURL_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
    NODE_EXTRA_CA_CERTS: workspaceMitmCaPath,
    GIT_SSL_CAINFO: "/etc/ssl/certs/ca-certificates.crt",
    NPM_CONFIG_CAFILE: "/etc/ssl/certs/ca-certificates.crt",
    YARN_CA_FILE: "/etc/ssl/certs/ca-certificates.crt",
    PIP_CERT: "/etc/ssl/certs/ca-certificates.crt",
  };
}

export function registerWorkspaceProxyEvents(events: AtelierEventBus): void {
  events.on("workspace_plan_prepare", async ({ workspaceId, init, plan }) => {
    const runtimeContext = getAtelierRuntimeContext();
    const secretContext = await createWorkspaceSecretContext(workspaceId, init);
    Object.assign(plan.env, secretContext.env);

    await ensureWorkspaceEgressProxy(workspaceId);
    Object.assign(plan.env, workspaceProxyEnv());
    // Repository init scripts can already use the proxy environment, so the
    // forwarder must start before any of them (and before nested dockerd).
    plan.mounts.push({ type: "bind", source: dockerHostAtelierDataPath(runtimeContext, "proxy-ca", "atelier-mitm-ca.pem"), target: workspaceMitmCaPath, readonly: true });
    plan.initScripts.unshift(
      workspaceLocalProxyInitScript(),
      `cat ${workspaceMitmCaPath} >> /etc/ssl/certs/ca-certificates.crt`,
      `su atelier -c ${shellQuote('git config --global http.proxy "$HTTPS_PROXY"')}`,
    );
    plan.cleanup.push(async () => cleanupWorkspaceProxy(workspaceId));
  });

  events.on("workspace_deleted", async ({ workspaceId }) => cleanupWorkspaceProxy(workspaceId));
}

async function cleanupWorkspaceProxy(workspaceId: string): Promise<void> {
  const existing = workspaceProxies.get(workspaceId);
  if (existing) {
    await (await existing).close();
    workspaceProxies.delete(workspaceId);
  }
  forgetWorkspaceSecretContext(workspaceId);
}

export async function ensureWorkspaceEgressProxy(workspaceId: string): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(workspaceId)) throw new Error("Invalid workspace id");
  let existing = workspaceProxies.get(workspaceId);
  if (!existing) {
    existing = (async () => startWorkspaceEgressProxy({
      socketPath: atelierDataPath(getAtelierRuntimeContext(), "workspace-sockets", workspaceId, "egress.sock"),
      ca: await ensureMitmCa(),
      getContext: () => getWorkspaceSecretContext(workspaceId),
    }))().catch(error => { workspaceProxies.delete(workspaceId); throw error; });
    workspaceProxies.set(workspaceId, existing);
  }
  await existing;
}

// The listener's closure supplies identity. Nothing in HTTP headers, CONNECT,
// or the requested URL can select another workspace's secrets.
export async function startWorkspaceEgressProxy({ socketPath, ca, getContext, upstreamFetch = fetch }: {
  socketPath: string; ca: MitmCa; getContext: SecretContext; upstreamFetch?: FetchUpstream;
}): Promise<WorkspaceEgressProxy> {
  const context: ProxyContext = { secrets: getContext, fetch: upstreamFetch };
  const connections = new Set<net.Socket>();
  const server = createServer((req, res) => void handleProxyHttp(context, req, res).catch((thrown) => {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    writeError(res, proxyFailure(error));
  }));
  server.on("connection", socket => { connections.add(socket); socket.once("close", () => connections.delete(socket)); });
  server.on("connect", (req, socket, head) => void handleConnect(ca, context, req, socket, head).catch((thrown) => {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    socket.end(connectErrorResponse(proxyFailure(error)));
  }));
  await mkdir(dirname(socketPath), { recursive: true });
  try { await unlink(socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  await chmod(socketPath, 0o666);
  server.unref();
  return { async close() {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

async function handleConnect(ca: MitmCa, context: ProxyContext, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const { hostname, port } = parseConnectTarget(req.url || "");
  await assertDestinationAllowed(context, hostname, port, port === 443 ? "https" : "http");
  if (!(await shouldMitmConnectTarget(context, hostname))) return tunnelConnect(hostname, port, socket, head);
  if (port !== 443) throw new HttpRequestBlockedError("MITM CONNECT only allowed to port 443");
  const targetServer = await ensureMitmTargetServer(ca, hostname);
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  let connectionPort: number | undefined;
  const bridge = net.connect(targetServer.port, "127.0.0.1", () => {
    connectionPort = bridge.localPort;
    if (connectionPort) targetServer.connections.set(connectionPort, { context, hostname });
    if (head.length) bridge.write(head);
  });
  socket.pipe(bridge).pipe(socket);
  const cleanup = () => {
    if (connectionPort) targetServer.connections.delete(connectionPort);
  };
  socket.on("error", () => bridge.destroy());
  bridge.on("error", () => socket.destroy());
  socket.once("close", () => { cleanup(); bridge.destroy(); });
  bridge.once("close", () => { cleanup(); socket.destroy(); });
}

async function shouldMitmConnectTarget(context: ProxyContext, hostname: string): Promise<boolean> {
  const secrets = await context.secrets();
  return secrets.secrets.some((secret) => secret.hosts.some((host) => matchHostname(hostname, host)));
}

async function tunnelConnect(hostname: string, port: number, socket: Duplex, head: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const upstream = net.connect(port, hostname);
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    upstream.once("error", onError);
    upstream.once("connect", () => {
      upstream.off("error", onError);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => socket.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
      resolve();
    });
  });
}

async function ensureMitmTargetServer(ca: MitmCa, hostname: string): Promise<MitmTargetServer> {
  const key = `${ca.dir}:${hostname.toLowerCase()}`;
  const existing = mitmTargetServers.get(key);
  let expiring: MitmTargetServer | undefined;
  if (existing) {
    const target = await existing;
    if (Date.now() < target.renewAt) return target;
    if (mitmTargetServers.get(key) !== existing) return await mitmTargetServers.get(key)!;
    expiring = target;
  }
  const created: Promise<MitmTargetServer> = startMitmTargetServer(ca, hostname).then((replacement) => {
    expiring?.server.close();
    return replacement;
  }).catch((error) => {
    if (mitmTargetServers.get(key) === created) {
      if (existing) mitmTargetServers.set(key, existing);
      else mitmTargetServers.delete(key);
    }
    throw error;
  });
  mitmTargetServers.set(key, created);
  return await created;
}

async function startMitmTargetServer(ca: MitmCa, hostname: string): Promise<MitmTargetServer> {
  const leaf = await ensureLeafCertificate(ca, hostname);
  const connections = new Map<number, MitmConnectionContext>();
  const server = createHttpsServer({
    cert: readFileSync(leaf.certPath),
    key: readFileSync(leaf.keyPath),
    ALPNProtocols: ["http/1.1"],
  }, (mitmReq, mitmRes) => {
    const remotePort = mitmReq.socket.remotePort;
    const context = remotePort ? connections.get(remotePort) : undefined;
    if (!context) {
      writeError(mitmRes, proxyFailure(new HttpRequestBlockedError("unknown MITM connection")));
      return;
    }
    const path = mitmReq.url || "/";
    mitmReq.url = `https://${context.hostname}${path.startsWith("/") ? path : `/${path}`}`;
    void handleProxyHttp(context.context, mitmReq, mitmRes).catch((thrown) => {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      writeError(mitmRes, proxyFailure(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  server.unref();
  // SAFETY: This server listens with a TCP host and port, so Node returns an
  // AddressInfo rather than the string address used by Unix-domain sockets.
  const address = server.address() as AddressInfo;
  return { server, port: address.port, connections, renewAt: leaf.renewAt };
}

async function handleProxyHttp(context: ProxyContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url === "/health" && req.method === "GET") { res.end("ok"); return; }
  const targetUrl = requestTargetUrl(req);
  const parsed = new URL(targetUrl);
  const protocol = parsed.protocol === "https:" ? "https" : "http";
  const port = parsed.port ? Number(parsed.port) : protocol === "https" ? 443 : 80;
  await assertDestinationAllowed(context, parsed.hostname, port, protocol);

  const method = (req.method || "GET").toUpperCase();
  const canHaveBody = !["GET", "HEAD"].includes(method);
  // SAFETY: Readable.toWeb returns a WHATWG ReadableStream at runtime. Node's
  // declaration differs from the DOM declaration only in overloads; Bun accepts it as BodyInit.
  const body = canHaveBody ? Readable.toWeb(req) as any : undefined;
  const requestInit: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: incomingHeaders(req),
    body,
  };
  if (canHaveBody) requestInit.duplex = "half";
  const request = new Request(parsed.toString(), requestInit);

  const secrets = await context.secrets();
  const hooks = secrets.hooks;
  let next: Request | Response = request;
  if (hooks?.onRequest) {
    const updated = await hooks.onRequest(request);
    if (updated) next = updated;
  }
  if (next instanceof Response) return await writeFetchResponse(res, next);
  if (hooks?.isRequestAllowed && !(await hooks.isRequestAllowed(new Request(next.url, { method: next.method, headers: next.headers })))) throw new HttpRequestBlockedError("request blocked by policy");

  const upstreamHeaders = filteredForwardHeaders(next.headers);
  const upstreamInit: RequestInit & { duplex?: "half" } = {
    method: next.method,
    headers: upstreamHeaders,
    body: ["GET", "HEAD"].includes(next.method.toUpperCase()) ? undefined : next.body,
    redirect: "manual",
  };
  if (!["GET", "HEAD"].includes(next.method.toUpperCase())) upstreamInit.duplex = "half";
  const upstream = await context.fetch(next.url, upstreamInit);
  const finalResponse = hooks?.onResponse ? await hooks.onResponse(upstream, next) ?? upstream : upstream;
  await writeFetchResponse(res, finalResponse);
}

async function assertDestinationAllowed(context: ProxyContext, hostname: string, port: number, protocol: "http" | "https"): Promise<void> {
  const secrets = await context.secrets();
  const hooks = secrets.hooks;
  if (!hooks.isIpAllowed) return;
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

interface ConnectTarget {
  hostname: string;
  port: number;
}

function parseConnectTarget(target: string): ConnectTarget {
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
  const out = stripHopByHopHeaders(headers, ["proxy-connection"]);
  // Keep upstream response framing predictable for strict clients such as
  // dockerd/BuildKit. If fetch transparently decodes a compressed response,
  // the upstream Content-Length would no longer match the bytes we forward.
  out.set("accept-encoding", "identity");
  return out;
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  response.headers.forEach((value, key) => {
    if (isHopByHopHeader(key) || key.toLowerCase() === "content-encoding") return;
    res.setHeader(key, value);
  });
  const body = response.body;
  if (!body) { res.end(); return; }
  await new Promise<void>((resolve, reject) => {
    Readable.from(body).on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
  });
}

interface ProxyFailure {
  status: number;
  statusText: string;
  message: string;
}

function proxyFailure(error: Error): ProxyFailure {
  if (error instanceof HttpRequestBlockedError) return { status: error.status, statusText: error.statusText, message: error.message };
  return { status: 502, statusText: "Bad Gateway", message: error.message };
}

function writeError(res: ServerResponse, failure: ProxyFailure): void {
  res.writeHead(failure.status, failure.statusText, { "content-type": "text/plain" });
  res.end(`${failure.message}\n`);
}

function connectErrorResponse(failure: ProxyFailure): string {
  const headers = [
    `HTTP/1.1 ${failure.status} ${failure.statusText}`,
    "Connection: close",
    "Content-Type: text/plain",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${failure.message}\n`;
}
