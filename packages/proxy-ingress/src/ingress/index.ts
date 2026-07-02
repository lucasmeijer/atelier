import type { ServerWebSocket } from "bun";
import { stripHopByHopHeaders } from "../proxy-headers.ts";
import {
  defaultPublicProxyPortRange,
  ensureWorkspacePublicProxyRoute,
  listWorkspacePublicProxyRoutes,
  publicProxyPortRangeFromEnv,
  releaseWorkspacePublicProxyRoute,
  releaseWorkspacePublicProxyRoutes,
  type PublicProxyPortRange,
  type WorkspacePublicProxyRoute,
} from "./route-state.ts";
import type { PublicProxyPortExposer } from "./tailscale-serve.ts";

export interface WorkspaceAppHost {
  appKey: string;
  workspaceId: string;
}

export class UnknownWorkspaceAppError extends Error {
  constructor(public readonly app: WorkspaceAppHost) {
    super(`unknown workspace app: ${app.appKey}`);
    this.name = "UnknownWorkspaceAppError";
  }
}

export type WorkspaceAppTargetResolver = (app: WorkspaceAppHost, requestUrl: URL) => Promise<URL> | URL;
export type WorkspaceAppRequestHeaderTransformer = (app: WorkspaceAppHost, headers: Headers, target: URL, request: Request) => Promise<Headers> | Headers;
export type WorkspaceAppResponseTransformer = (app: WorkspaceAppHost, response: Response, request: Request) => Promise<Response> | Response;
export type WorkspaceIngressAuthHandler = (request: Request) => Promise<Response | undefined> | Response | undefined;

export interface WorkspaceIngressProxyOptions {
  hostname: string;
  authResponse?: WorkspaceIngressAuthHandler;
  resolveWorkspace(workspaceId: string): Promise<unknown> | unknown;
  listWorkspaceIds(): Promise<string[]> | string[];
  resolveTarget: WorkspaceAppTargetResolver;
  transformRequestHeaders?: WorkspaceAppRequestHeaderTransformer;
  transformResponse?: WorkspaceAppResponseTransformer;
  publicPortRange?: PublicProxyPortRange;
  publicPortExposer?: PublicProxyPortExposer;
}

export interface WorkspaceIngressProxyService {
  startPersistedRoutes(): Promise<void>;
  redirectToRoute(workspaceId: string, appKey: string, path: string, request: Request): Promise<Response>;
  ensureRoute(workspaceId: string, appKey: string): Promise<WorkspaceAppHost & WorkspacePublicProxyRoute>;
  stopWorkspace(workspaceId: string): Promise<number[]>;
  stopAll(): Promise<number[]>;
}

interface WorkspaceAppProxySocketData {
  kind: "workspace-app-proxy";
  target: string;
  host: string;
  protocols: string[];
  upstream?: WebSocket;
  pending?: Array<string | ArrayBuffer>;
}

export {
  defaultPublicProxyPortRange,
  ensureWorkspacePublicProxyRoute,
  listWorkspacePublicProxyRoutes,
  publicProxyPortRangeFromEnv,
  releaseWorkspacePublicProxyRoute,
  releaseWorkspacePublicProxyRoutes,
  type PublicProxyPortRange,
  type WorkspacePublicProxyRoute,
};
export * from "./tailscale-serve.ts";

export function createWorkspaceIngressProxy(options: WorkspaceIngressProxyOptions): WorkspaceIngressProxyService {
  const publicPortRange = options.publicPortRange ?? publicProxyPortRangeFromEnv();
  const publicProxyServers = new Map<number, ReturnType<typeof Bun.serve<WorkspaceAppProxySocketData>>>();
  const publicProxyRoutes = new Map<number, WorkspaceAppHost>();

  async function retireUnknownAppRoute(publicPort: number, app: WorkspaceAppHost): Promise<Response> {
    await releaseWorkspacePublicProxyRoute(app.workspaceId, app.appKey);
    await options.publicPortExposer?.releasePort(publicPort);
    publicProxyRoutes.delete(publicPort);
    const staleServer = publicProxyServers.get(publicPort);
    publicProxyServers.delete(publicPort);
    setTimeout(() => staleServer?.stop(true), 0);
    return textResponse(`Workspace app is gone: ${app.appKey}`, 410);
  }

  async function ensurePublicProxyListener(route: WorkspaceAppHost & { publicPort: number }): Promise<void> {
    const existing = publicProxyRoutes.get(route.publicPort);
    if (existing) {
      if (existing.workspaceId === route.workspaceId && existing.appKey === route.appKey && publicProxyServers.has(route.publicPort)) return;
      throw new Error(`public proxy port ${route.publicPort} is already assigned`);
    }
    if (publicProxyServers.has(route.publicPort)) throw new Error(`public proxy port ${route.publicPort} is already listening`);
    publicProxyRoutes.set(route.publicPort, { workspaceId: route.workspaceId, appKey: route.appKey });
    try {
      const server = Bun.serve<WorkspaceAppProxySocketData>({
        hostname: options.hostname,
        port: route.publicPort,
        idleTimeout: 255,
        async fetch(request, server) {
          const auth = await options.authResponse?.(request);
          if (auth) return auth;
          const url = new URL(request.url);
          const app = publicProxyRoutes.get(route.publicPort);
          if (!app) return textResponse("not found", 404);
          if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
            try {
              const protocols = websocketProtocols(request);
              const target = await workspaceAppWebSocketTarget(app, url.pathname, url.search, options.resolveTarget);
              if (server.upgrade(request, { data: { kind: "workspace-app-proxy", target, host: request.headers.get("host") ?? url.host, protocols } })) return undefined;
              return textResponse("websocket upgrade failed", 400);
            } catch (error) {
              if (error instanceof UnknownWorkspaceAppError) return await retireUnknownAppRoute(route.publicPort, app);
              throw error;
            }
          }
          return await proxyWorkspaceAppRequest(app, request, options.resolveTarget, options.transformRequestHeaders, options.transformResponse, () => retireUnknownAppRoute(route.publicPort, app));
        },
        websocket: {
          open: openWorkspaceAppProxySocket,
          message: handleWorkspaceAppProxySocketMessage,
          close: closeWorkspaceAppProxySocket,
        },
      });
      publicProxyServers.set(route.publicPort, server);
    } catch (error) {
      publicProxyRoutes.delete(route.publicPort);
      throw error;
    }
  }

  async function releasePublicPorts(ports: Iterable<number>): Promise<void> {
    await Promise.all([...ports].map((port) => options.publicPortExposer?.releasePort(port)));
  }

  function stopPublicProxyListeners(predicate: (route: WorkspaceAppHost) => boolean): number[] {
    const ports: number[] = [];
    for (const [port, route] of [...publicProxyRoutes]) {
      if (!predicate(route)) continue;
      publicProxyServers.get(port)?.stop(true);
      publicProxyServers.delete(port);
      publicProxyRoutes.delete(port);
      ports.push(port);
    }
    return ports;
  }

  async function ensureRoute(workspaceId: string, appKey: string): Promise<WorkspaceAppHost & WorkspacePublicProxyRoute> {
    const unavailable = new Set<number>();
    for (;;) {
      const route = await ensureWorkspacePublicProxyRoute(workspaceId, appKey, { range: publicPortRange, reservedPorts: unavailable });
      try {
        await ensurePublicProxyListener({ workspaceId, appKey, publicPort: route.publicPort });
      } catch {
        unavailable.add(route.publicPort);
        await releaseWorkspacePublicProxyRoute(workspaceId, appKey);
        if (unavailable.size > publicPortRange.end - publicPortRange.start + 1) throw new Error(`no public proxy ports available in range ${publicPortRange.start}-${publicPortRange.end}`);
        continue;
      }
      await options.publicPortExposer?.ensurePort(route.publicPort);
      return { workspaceId, appKey, publicPort: route.publicPort };
    }
  }

  return {
    async startPersistedRoutes() {
      const ids = await options.listWorkspaceIds();
      const startedPorts: number[] = [];
      for (const route of await listWorkspacePublicProxyRoutes(ids)) {
        try {
          await ensurePublicProxyListener(route);
          startedPorts.push(route.publicPort);
        } catch { /* stale/unavailable route will be reallocated on next canonical request */ }
      }
      await options.publicPortExposer?.syncPorts(startedPorts);
    },
    async redirectToRoute(workspaceId, appKey, path, request) {
      await options.resolveWorkspace(workspaceId);
      const route = await ensureRoute(workspaceId, appKey);
      const normalizedPath = path.startsWith("/") ? path : `/${path}`;
      return Response.redirect(`${publicProxyOrigin(request, route.publicPort)}${normalizedPath}`, 302);
    },
    ensureRoute,
    async stopWorkspace(workspaceId) {
      const ports = stopPublicProxyListeners((route) => route.workspaceId === workspaceId);
      await releasePublicPorts(ports);
      return ports;
    },
    async stopAll() {
      const ports = stopPublicProxyListeners(() => true);
      await releasePublicPorts(ports);
      return ports;
    },
  };
}

export function publicWorkspaceAppOrigin(request: Request): string {
  const url = new URL(request.url);
  return `${publicWorkspaceAppProtocol(request, url)}://${publicWorkspaceAppHost(request, url)}`;
}

function publicWorkspaceAppProtocol(request: Request, url = new URL(request.url)): string {
  return request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "");
}

function publicWorkspaceAppHost(request: Request, url = new URL(request.url)): string {
  return request.headers.get("host") ?? url.host;
}

function publicWorkspaceAppPort(host: string, protocol: string): string {
  try {
    return new URL(`${protocol}://${host}`).port || (protocol === "https" ? "443" : "80");
  } catch {
    return protocol === "https" ? "443" : "80";
  }
}

function publicProxyOrigin(request: Request, publicPort: number): string {
  const url = new URL(request.url);
  const proto = publicWorkspaceAppProtocol(request, url);
  return `${proto}://${hostForOrigin(publicProxyHostFor(request, url))}:${publicPort}`;
}

function hostForOrigin(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function publicProxyHostFor(request: Request, url = new URL(request.url)): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = hostnameWithoutPort(forwardedHost || url.host) || url.hostname;
  return host === "0.0.0.0" ? "127.0.0.1" : host;
}

function hostnameWithoutPort(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    if (host.startsWith("[") && host.includes("]")) return host.slice(1, host.indexOf("]"));
    const colonCount = [...host].filter((char) => char === ":").length;
    if (colonCount === 0) return host;
    if (colonCount === 1) return host.split(":")[0];
    return host;
  }
}

async function proxyWorkspaceAppRequest(
  app: WorkspaceAppHost,
  request: Request,
  resolveTarget: WorkspaceAppTargetResolver,
  transformRequestHeaders?: WorkspaceAppRequestHeaderTransformer,
  transformResponse?: WorkspaceAppResponseTransformer,
  retireUnknownAppRoute?: () => Promise<Response>,
): Promise<Response> {
  try {
    const source = new URL(request.url);
    const target = await resolveTarget(app, source);
    let headers = stripHopByHopHeaders(request.headers, ["host"]);
    const sourceProto = publicWorkspaceAppProtocol(request, source);
    const sourceHost = publicWorkspaceAppHost(request, source);
    headers.set("host", sourceHost);
    headers.set("x-forwarded-host", sourceHost);
    headers.set("x-forwarded-proto", sourceProto);
    const sourcePort = publicWorkspaceAppPort(sourceHost, sourceProto);
    if (sourcePort) headers.set("x-forwarded-port", sourcePort);
    if (transformRequestHeaders) headers = await transformRequestHeaders(app, headers, target, request);
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
    return transformResponse ? await transformResponse(app, response, request) : response;
  } catch (error) {
    if (error instanceof UnknownWorkspaceAppError && retireUnknownAppRoute) return await retireUnknownAppRoute();
    const message = error instanceof Error ? error.message : String(error);
    return textResponse(`Workspace app proxy error: ${message}`, 502);
  }
}

async function workspaceAppWebSocketTarget(app: WorkspaceAppHost, pathname: string, search: string, resolveTarget: WorkspaceAppTargetResolver): Promise<string> {
  const target = await resolveTarget(app, new URL(`${pathname}${search}`, "http://workspace-app.localhost"));
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}

function websocketProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((protocol) => protocol.trim()).filter(Boolean);
}

function openWorkspaceAppProxySocket(ws: ServerWebSocket<WorkspaceAppProxySocketData>): void {
  const WebSocketWithOptions = WebSocket as unknown as new (url: string, options: { headers?: Record<string, string>; protocols?: string[] }) => WebSocket;
  const upstream = new WebSocketWithOptions(ws.data.target, { headers: { Host: ws.data.host }, protocols: ws.data.protocols });
  upstream.binaryType = "arraybuffer";
  const pending: Array<string | ArrayBuffer> = [];
  ws.data.upstream = upstream;
  ws.data.pending = pending;
  upstream.addEventListener("open", () => {
    for (const message of pending.splice(0)) upstream.send(message);
  });
  upstream.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      ws.send(event.data);
    } else if (event.data instanceof ArrayBuffer) {
      ws.send(event.data);
    } else if (event.data instanceof Blob) {
      void event.data.arrayBuffer().then((buffer) => ws.send(buffer)).catch(() => ws.close());
    }
  });
  upstream.addEventListener("close", () => ws.close());
  upstream.addEventListener("error", () => ws.close());
}

function handleWorkspaceAppProxySocketMessage(ws: ServerWebSocket<WorkspaceAppProxySocketData>, message: string | Buffer): void {
  const payload = typeof message === "string" ? message : new Uint8Array(message).slice().buffer;
  if (ws.data.upstream?.readyState === WebSocket.OPEN) ws.data.upstream.send(payload);
  else ws.data.pending?.push(payload);
}

function closeWorkspaceAppProxySocket(ws: ServerWebSocket<WorkspaceAppProxySocketData>): void {
  const upstream = ws.data.upstream;
  if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close();
}

function textResponse(text: string, status: number): Response {
  return new Response(`${text}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
