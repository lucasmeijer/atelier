import dns from "node:dns/promises";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import tls from "node:tls";
import { dockerHostAtelierDataPath, getAtelierRuntimeContext, shellQuote } from "@atelier/core";
import { HttpRequestBlockedError } from "../secrets/errors.ts";
import { matchHostname } from "../secrets/patterns.ts";
import { createWorkspaceSecretContext, forgetWorkspaceSecretContext, getWorkspaceSecretContext } from "../secrets/workspace-secrets.ts";
import type { AtelierEventBus } from "@atelier/core";
import { isHopByHopHeader, stripHopByHopHeaders } from "@atelier/shared";
import { authenticateProxyRequest, ensureWorkspaceProxyAuthToken, forgetWorkspaceProxyAuthToken } from "./auth-store.ts";
import { defaultNoProxyEntries, uniqueNoProxyEntries } from "./no-proxy.ts";
import { ensureLeafCertificate, ensureMitmCa, type MitmCa } from "./mitm-ca.ts";

export const atelierWorkspaceProxyPort = 58123;
type AtelierWorkspaceProxy = { port: number; close(): Promise<void> };

const workspaceMitmCaPath = "/run/atelier-mitm-ca.crt";

let sharedProxy: Promise<AtelierWorkspaceProxy> | undefined;
const mitmTargetServers = new Map<string, Promise<MitmTargetServer>>();

type MitmConnectionContext = { workspaceId: string; hostname: string };
type MitmTargetServer = { server: ReturnType<typeof createHttpsServer>; port: number; connections: Map<number, MitmConnectionContext> };

function workspaceProxyHost(): string {
  return getAtelierRuntimeContext().dockerBridgeHost;
}

function workspaceProxyUrl(workspaceId: string, token: string): string {
  return `http://${encodeURIComponent(workspaceId)}:${encodeURIComponent(token)}@${workspaceProxyHost()}:${atelierWorkspaceProxyPort}`;
}

async function workspaceProxyEnv(workspaceId: string, token: string): Promise<Record<string, string>> {
  const proxy = workspaceProxyUrl(workspaceId, token);
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
    NODE_EXTRA_CA_CERTS: "/usr/local/share/ca-certificates/atelier-mitm-ca.crt",
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

    const proxyAuthToken = await ensureWorkspaceProxyAuthToken(workspaceId);
    await ensureAtelierWorkspaceProxy();
    await ensureMitmCa(runtimeContext);
    Object.assign(plan.env, await workspaceProxyEnv(workspaceId, proxyAuthToken));
    plan.mounts.push({ type: "bind", source: dockerHostAtelierDataPath(runtimeContext, "proxy-ca", "atelier-mitm-ca.pem"), target: workspaceMitmCaPath, readonly: true });
    plan.initScripts.push(`if [ -r ${workspaceMitmCaPath} ]; then mkdir -p /usr/local/share/ca-certificates; cp ${workspaceMitmCaPath} /usr/local/share/ca-certificates/atelier-mitm-ca.crt; cat ${workspaceMitmCaPath} >> /etc/ssl/certs/ca-certificates.crt; fi`);
    plan.initScripts.push(`su atelier -c ${shellQuote('git config --global http.proxy "$HTTPS_PROXY"; git config --global http.proxyAuthMethod basic')}`);
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

async function stopAtelierWorkspaceProxy(): Promise<void> {
  const proxy = await sharedProxy?.catch(() => undefined);
  sharedProxy = undefined;
  await proxy?.close();
  await closeMitmTargetServers();
}

async function startAtelierWorkspaceProxy(): Promise<AtelierWorkspaceProxy> {
  const ca = await ensureMitmCa();
  const server = createServer((req, res) => void handleProxyHttpRequest(req, res).catch((error) => writeError(res, error)));
  server.on("connect", (req, socket, head) => void handleConnect(ca, req, socket as net.Socket, head).catch((error) => {
    const netSocket = socket as net.Socket;
    netSocket.write(connectErrorResponse(error));
    netSocket.destroy();
  }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(atelierWorkspaceProxyPort, "0.0.0.0", () => { server.off("error", reject); resolve(); });
  });
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
  await assertDestinationAllowed(workspaceId, hostname, port, port === 443 ? "https" : "http");
  if (!(await shouldMitmConnectTarget(workspaceId, hostname))) return tunnelConnect(hostname, port, socket, head);
  if (port !== 443) throw new HttpRequestBlockedError("MITM CONNECT only allowed to port 443");
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

async function shouldMitmConnectTarget(workspaceId: string, hostname: string): Promise<boolean> {
  const context = await getWorkspaceSecretContext(workspaceId);
  return context.secrets.some((secret) => secret.hosts.some((host) => matchHostname(hostname, host)));
}

async function tunnelConnect(hostname: string, port: number, socket: net.Socket, head: Buffer): Promise<void> {
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
  const hooks = context.hooks;
  let next: Request | Response = request;
  if (hooks?.onRequest) {
    const updated = await hooks.onRequest(request);
    if (updated) next = updated;
  }
  if (next instanceof Response) return await writeFetchResponse(res, next);
  if (hooks?.isRequestAllowed && !(await hooks.isRequestAllowed(new Request(next.url, { method: next.method, headers: next.headers })))) throw new HttpRequestBlockedError("request blocked by policy");

  const upstreamHeaders = filteredForwardHeaders(next.headers);
  const upstream = await fetch(next.url, {
    method: next.method,
    headers: upstreamHeaders,
    body: ["GET", "HEAD"].includes(next.method.toUpperCase()) ? undefined : next.body,
    redirect: "manual",
    ...(!["GET", "HEAD"].includes(next.method.toUpperCase()) ? ({ duplex: "half" } as const) : {}),
  });
  const finalResponse = hooks?.onResponse ? await hooks.onResponse(upstream, next) ?? upstream : upstream;
  await writeFetchResponse(res, finalResponse);
}

async function assertDestinationAllowed(workspaceId: string, hostname: string, port: number, protocol: "http" | "https"): Promise<void> {
  const context = await getWorkspaceSecretContext(workspaceId);
  const hooks = context.hooks;
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
