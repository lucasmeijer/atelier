import { adaptLocalAppResponse, localAppHost, translateLocalAppOrigin } from "./local-app.ts";
import { backendTransport } from "./backend-transport.ts";
import type { ServerWebSocket } from "bun";
import { workspaceGatewayErrorHeader, stripHopByHopHeaders, workspaceProxyUrl, type WorkspaceAppBackend, type WorkspaceAppRef, type WorkspaceHttpAppBackend } from "@atelier/shared";
import { createMemoryOriginIdentityStore, type OriginIdentityStore } from "./origin-identity.ts";
import { closeWebSocket } from "./websocket.ts";
import {
  defaultPublicOriginPortRange,
  publicOriginPortRangeFromEnv,
  type OriginPublisher,
  type PortRange,
} from "./tailscale-serve.ts";

export class UnknownWorkspaceAppError extends Error {
  constructor(public readonly app: WorkspaceAppRef) {
    super(`unknown workspace app: ${app.appKey}`);
    this.name = "UnknownWorkspaceAppError";
  }
}

export class StoppedWorkspaceError extends Error {
  constructor(public readonly workspaceId: string) {
    super(`Workspace ${workspaceId} is stopped. Start the workspace and try again.`);
    this.name = "StoppedWorkspaceError";
  }
}

export type WorkspaceAppHost = WorkspaceAppRef;
export type WorkspaceAppResolver = (app: WorkspaceAppRef, requestUrl: URL) => Promise<WorkspaceAppBackend | undefined> | WorkspaceAppBackend | undefined;

export interface WorkspaceIngressOptions {
  hostname: string;
  resolveWorkspace(workspaceId: string): Promise<void> | void;
  resolveApp: WorkspaceAppResolver;
  originPortRange?: PortRange;
  originPublisher?: OriginPublisher;
  originIdentityStore?: OriginIdentityStore;
  leaseIdleMs?: number;
}

export interface IngressStatus {
  workspaceId: string;
  appKey: string;
  port?: number;
  scope?: "public" | "nested";
  activeConnections: number;
  lastUsedAt: number;
  lastFailure?: string;
  failureCategory?: string;
  target?: string;
  targetState: "active" | "inactive" | "failed";
}

export interface WorkspaceIngress {
  initialize(): Promise<void>;
  openCanonical(app: WorkspaceAppRef, pathAndSearch: string, request: Request): Promise<Response>;
  stopWorkspace(workspaceId: string): Promise<void>;
  stopAll(): Promise<void>;
  inspect(app?: WorkspaceAppRef): IngressStatus[];
}

interface AppSocketData {
  lease: OriginLease;
  upstream: WebSocket;
}

interface PublicRequestContext {
  protocol: string;
  host: string;
  port: string;
}

interface IngressLogDetails {
  port?: number;
  scope?: "public" | "nested";
  error?: string;
  category?: string;
}

interface RecentFailure {
  app: WorkspaceAppRef;
  message: string;
  category: string;
  at: number;
}

interface ParentAtelier {
  origin: string;
  workspaceId: string;
}

interface OriginLease {
  key: string;
  app: WorkspaceAppRef;
  port: number;
  scope: "public" | "nested";
  server: ReturnType<typeof Bun.serve<AppSocketData>>;
  parentContext?: ParentAtelier;
  activeConnections: number;
  lastUsedAt: number;
  lastFailure?: string;
  target?: string;
}

// Nested listeners need no individually published Docker ports. Preserve old
// assignments while allowing more than ten nested origins.
const nestedOriginPortRange: PortRange = { start: 3001, end: 65535 };
const parentOriginHeader = "x-atelier-parent-origin";
const parentWorkspaceHeader = "x-atelier-parent-workspace";
// Like parent routing context, this is supplied by ingress, never browser input.
const originContextHeader = "x-atelier-origin-context";
const publicOriginHeader = "x-atelier-public-origin";
export const nestedWorkspaceProxyRedirectHeader = "x-atelier-nested-workspace-proxy-redirect";

export * from "./tailscale-serve.ts";
export { isSameLocalApp } from "./local-app.ts";
export { createFileOriginIdentityStore, createMemoryOriginIdentityStore, type OriginIdentityStore } from "./origin-identity.ts";

export function createWorkspaceIngress(options: WorkspaceIngressOptions): WorkspaceIngress {
  const publicRange = options.originPortRange ?? publicOriginPortRangeFromEnv();
  const leaseIdleMs = options.leaseIdleMs ?? 10 * 60_000;
  const identityStore = options.originIdentityStore ?? createMemoryOriginIdentityStore();
  const leases = new Map<string, OriginLease>();
  const pendingLeases = new Map<string, Promise<OriginLease>>();
  const recentFailures = new Map<string, RecentFailure>();

  function recordFailure(app: WorkspaceAppRef, error: Error): void {
    recentFailures.set(appIdentity(app), { app, message: error.message, category: errorCategory(error), at: Date.now() });
    while (recentFailures.size > 200) recentFailures.delete(recentFailures.keys().next().value!);
  }

  const sweepTimer = setInterval(() => {
    const cutoff = Date.now() - leaseIdleMs;
    for (const lease of leases.values()) {
      if (lease.activeConnections === 0 && lease.lastUsedAt < cutoff) void releaseLease(lease);
    }
  }, Math.min(60_000, Math.max(100, Math.floor(leaseIdleMs / 2))));
  sweepTimer.unref?.();

  async function resolveBackend(app: WorkspaceAppRef, requestUrl: URL): Promise<WorkspaceAppBackend> {
    const backend = await options.resolveApp(app, requestUrl);
    if (!backend) throw new UnknownWorkspaceAppError(app);
    return backend;
  }

  async function ensureLease(app: WorkspaceAppRef, scope: "public" | "nested", parentContext?: ParentAtelier): Promise<OriginLease> {
    const key = leaseKey(app, scope, parentContext);
    const existing = leases.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      if (parentContext) existing.parentContext = parentContext;
      return existing;
    }
    const pending = pendingLeases.get(key);
    if (pending) {
      const lease = await pending;
      if (parentContext) lease.parentContext = parentContext;
      return lease;
    }

    const created = startLease(key, app, scope, parentContext).finally(() => pendingLeases.delete(key));
    pendingLeases.set(key, created);
    return await created;
  }

  async function startLease(key: string, app: WorkspaceAppRef, scope: "public" | "nested", parentContext?: ParentAtelier): Promise<OriginLease> {
    const range = scope === "public" ? publicRange : nestedOriginPortRange;
    const assignment = await identityStore.assignedPort(app, scope, range);
    const port = assignment.port;
    let lease: OriginLease;
    try {
      const server = Bun.serve<AppSocketData>({
          hostname: options.hostname,
          port,
          idleTimeout: 255,
          async fetch(request, server) {
            lease.lastUsedAt = Date.now();
            if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
              try {
                const backend = await resolveBackend(lease.app, new URL(request.url));
                if (backend.kind !== "http") return textResponse("This workspace app does not support WebSockets", 400);
                lease.target = backend.target.toString();
                const { headers: upstreamHeaders } = await appRequestHeaders(lease, backend, request);
                for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"]) upstreamHeaders.delete(name);
                const transport = backendTransport(backend, upstreamHeaders);
                const upstream = await openUpstreamSocket(websocketTarget(transport.target), transport.headers, websocketProtocols(request));
                const headers = upstream.protocol ? { "sec-websocket-protocol": upstream.protocol } : undefined;
                if (server.upgrade(request, { data: { upstream, lease }, headers })) return undefined;
                upstream.close(1011, "Downstream WebSocket upgrade failed");
                return textResponse("WebSocket upgrade failed", 400);
              } catch (thrown) {
                const error = thrown instanceof Error ? thrown : new Error(String(thrown));
                lease.lastFailure = error.message;
                recordFailure(lease.app, error);
                logIngress("websocket_failed", lease.app, { port: lease.port, error: lease.lastFailure, category: errorCategory(error) });
                return ingressError(error);
              }
            }
            return await dispatchRequest(lease, request);
          },
          websocket: {
            open: openAppSocket,
            message: handleAppSocketMessage,
            close: closeAppSocket,
          },
        });
        lease = {
          key,
          app,
          port,
          scope,
          server,
          parentContext,
          activeConnections: 0,
          lastUsedAt: Date.now(),
        };
      leases.set(key, lease);
      if (scope === "public") await options.originPublisher?.publish(port);
      logIngress("lease_started", app, { port, scope });
      return lease;
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      const started = leases.get(key);
      if (started?.port === port) {
        leases.delete(key);
        started.server.stop(true);
      }
      if (isAddressInUse(error) && assignment.fresh) {
        await identityStore.rejectFreshPort(app, scope, port);
        return await startLease(key, app, scope, parentContext);
      }
      if (isAddressInUse(error)) throw new Error(`Retained browser origin ${port} for ${app.appKey} is currently unavailable because another process is using it`);
      throw error;
    }
  }

  async function dispatchRequest(lease: OriginLease, request: Request): Promise<Response> {
    lease.activeConnections += 1;
    try {
      const backend = await resolveBackend(lease.app, new URL(request.url));
      if (backend.kind === "fetch") {
        const response = adaptWorkspaceEmbedding(await backend.fetch(request));
        lease.lastFailure = undefined;
        recentFailures.delete(appIdentity(lease.app));
        return trackResponse(lease, response);
      }

      lease.target = backend.target.toString();
      const upstreamRequest = await appRequestHeaders(lease, backend, request);
      const transport = backendTransport(backend, upstreamRequest.headers);

      const method = request.method.toUpperCase();
      const init: RequestInit & { duplex?: "half"; proxy?: string } = {
        method,
        headers: transport.headers,
        // Bun 1.4 ignores proxy: "" for fetch. Use the gateway as BOTH URL and
        // explicit proxy: whether NO_PROXY bypasses it or not, traffic can only
        // reach this gateway, never an environment-selected proxy or the app.
        proxy: backend.gateway?.url.toString(),
        signal: request.signal,
        body: method === "GET" || method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      };
      if (init.body) init.duplex = "half";
      let response = normalizeDecodedFetchResponse(await fetchWithStartupRetry(transport.target, init, Boolean(backend.gateway)));
      // Module response adapters need the public identity, not spoofable request
      // metadata or the local forwarded headers seen by the app.
      request.headers.set(publicOriginHeader, appPublicOrigin(lease, request));
      if (backend.adaptResponse) response = await backend.adaptResponse(response, request);
      response = adaptLocalAppResponse(backend, response, appPublicOrigin(lease, request), upstreamRequest.originTranslation);
      response = adaptWorkspaceEmbedding(response);
      lease.lastFailure = undefined;
      recentFailures.delete(appIdentity(lease.app));
      return trackResponse(lease, response);
    } catch (thrown) {
      finishRequest(lease);
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      lease.lastFailure = error.message;
      recordFailure(lease.app, error);
      logIngress("request_failed", lease.app, { port: lease.port, error: lease.lastFailure, category: errorCategory(error) });
      if (error instanceof UnknownWorkspaceAppError) void releaseLease(lease);
      return ingressError(error);
    }
  }

  async function releaseLease(lease: OriginLease): Promise<void> {
    if (leases.get(lease.key) !== lease) return;
    leases.delete(lease.key);
    lease.server.stop(true);
    if (lease.scope === "public") await options.originPublisher?.unpublish(lease.port);
    logIngress("lease_released", lease.app, { port: lease.port, scope: lease.scope });
  }

  return {
    async initialize() {
      await options.originPublisher?.reset([]);
    },

    async openCanonical(app, pathAndSearch, request) {
      try {
        await options.resolveWorkspace(app.workspaceId);
        const normalizedPath = pathAndSearch.startsWith("/") ? pathAndSearch : `/${pathAndSearch}`;
        const requestUrl = new URL(normalizedPath, request.url);
        await resolveBackend(app, requestUrl);

        const parent = parentAtelier(request);
        if (parent) {
          const lease = await ensureLease(app, "nested");
          const location = `${parent.origin}${workspaceProxyUrl(parent.workspaceId, `port-${lease.port}`, normalizedPath)}`;
          const response = Response.redirect(location, 302);
          response.headers.set(nestedWorkspaceProxyRedirectHeader, "1");
          return response;
        }

        const parentContext = { origin: publicAtelierOrigin(request), workspaceId: app.workspaceId };
        const lease = await ensureLease(app, "public", parentContext);
        return Response.redirect(`${publicLeaseOrigin(request, lease.port)}${normalizedPath}`, 302);
      } catch (thrown) {
        const error = thrown instanceof Error ? thrown : new Error(String(thrown));
        recordFailure(app, error);
        logIngress("canonical_failed", app, { error: error.message, category: errorCategory(error) });
        return ingressError(error);
      }
    },

    async stopWorkspace(workspaceId) {
      await Promise.all([...leases.values()].filter((lease) => lease.app.workspaceId === workspaceId).map(releaseLease));
    },

    async stopAll() {
      clearInterval(sweepTimer);
      await Promise.all([...leases.values()].map(releaseLease));
      await options.originPublisher?.reset([]);
    },

    inspect(app) {
      const statuses: IngressStatus[] = [...leases.values()]
        .filter((lease) => !app || sameApp(lease.app, app))
        .map((lease) => ({
          workspaceId: lease.app.workspaceId,
          appKey: lease.app.appKey,
          port: lease.port,
          scope: lease.scope,
          activeConnections: lease.activeConnections,
          lastUsedAt: lease.lastUsedAt,
          lastFailure: lease.lastFailure,
          failureCategory: lease.lastFailure ? recentFailures.get(appIdentity(lease.app))?.category : undefined,
          target: lease.target,
          targetState: lease.lastFailure ? "failed" : "active",
        }));
      for (const failure of recentFailures.values()) {
        if ((app && !sameApp(failure.app, app)) || statuses.some((status) => status.workspaceId === failure.app.workspaceId && status.appKey === failure.app.appKey)) continue;
        statuses.push({ workspaceId: failure.app.workspaceId, appKey: failure.app.appKey, activeConnections: 0, lastUsedAt: failure.at, lastFailure: failure.message, failureCategory: failure.category, targetState: "failed" });
      }
      return statuses;
    },
  };
}

async function appRequestHeaders(lease: OriginLease, backend: WorkspaceHttpAppBackend, request: Request) {
  let headers = stripHopByHopHeaders(request.headers, ["host"]);
  // Give apps one coherent local origin, including frameworks that prefer
  // forwarded headers to Host. Public routing identity is Atelier metadata only.
  const localHost = localAppHost(backend.target);
  headers.set("host", localHost);
  headers.set("x-forwarded-host", localHost);
  headers.set("x-forwarded-proto", backend.target.protocol.slice(0, -1));
  headers.set("x-forwarded-port", backend.target.port || (backend.target.protocol === "https:" ? "443" : "80"));
  headers.delete("forwarded");
  headers.set(publicOriginHeader, appPublicOrigin(lease, request));
  headers.delete(parentOriginHeader);
  headers.delete(parentWorkspaceHeader);
  if (lease.parentContext) {
    headers.set(parentOriginHeader, lease.parentContext.origin);
    headers.set(parentWorkspaceHeader, lease.parentContext.workspaceId);
  }
  const receivingOrigin = receivingAppOrigin(lease, request);
  const sameOrigin = receivingOrigin !== undefined && headers.get("origin") === receivingOrigin;
  const originTranslation = receivingOrigin === undefined ? undefined : translateLocalAppOrigin(backend, headers, receivingOrigin);
  // Attest the decision to nested Atelier. A foreign Origin could coincidentally
  // equal a nested listener's localhost address; it must stay foreign at that hop.
  headers.set(originContextHeader, sameOrigin ? headers.get("origin")! : "null");
  if (backend.adaptRequestHeaders) headers = await backend.adaptRequestHeaders(headers, request);

  return { headers, originTranslation };
}

function receivingAppOrigin(lease: OriginLease, request: Request): string | undefined {
  // Public identity was established when opening the canonical route. Do not let
  // request-supplied forwarding headers redefine which Origin counts as same-origin.
  if (lease.scope === "public") return appPublicOrigin(lease, request);
  // A translating parent attests this hop's origin (or "null" for a foreign one).
  // Parents forwarding Origin unchanged need only the existing public context.
  const context = request.headers.get(originContextHeader);
  return context === "null" ? undefined : context ?? publicWorkspaceAppOrigin(request);
}

function appPublicOrigin(lease: OriginLease, request: Request): string {
  if (lease.scope === "nested") return publicWorkspaceAppOrigin(request);
  const origin = new URL(lease.parentContext!.origin);
  origin.hostname = hostForOrigin(origin.hostname);
  origin.port = String(lease.port);
  return origin.origin;
}

async function fetchWithStartupRetry(target: URL, init: RequestInit, throughGateway: boolean): Promise<Response> {
  const retryable = init.method === "GET" || init.method === "HEAD";
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(target, init);
      if (throughGateway && response.headers.get(workspaceGatewayErrorHeader) === "upstream") {
        // Consume the failed response before retrying so its connection is reusable.
        const message = (await response.text()).trim();
        throw new Error(message || "Workspace app connection failed");
      }
      return response;
    } catch (error) {
      if (!retryable || attempt >= 2 || init.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

function trackResponse(lease: OriginLease, response: Response): Response {
  if (!response.body) {
    finishRequest(lease);
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    finishRequest(lease);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (thrown) {
        finish();
        controller.error(thrown);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function finishRequest(lease: OriginLease): void {
  lease.activeConnections -= 1;
  lease.lastUsedAt = Date.now();
}

function leaseKey(app: WorkspaceAppRef, scope: "public" | "nested", parent?: ParentAtelier): string {
  return `${scope}\0${parent?.origin ?? ""}\0${parent?.workspaceId ?? ""}\0${app.workspaceId}\0${app.appKey}`;
}

function parentAtelier(request: Request): ParentAtelier | undefined {
  const origin = request.headers.get(parentOriginHeader);
  const workspaceId = request.headers.get(parentWorkspaceHeader);
  if (!origin || !workspaceId) return undefined;
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(workspaceId)) throw new Error("invalid parent Atelier routing context");
  return { origin, workspaceId };
}

export function publicWorkspaceAppOrigin(request: Request): string {
  return publicAtelierOrigin(request);
}

function publicAtelierOrigin(request: Request): string {
  const context = publicRequestContext(request);
  return `${context.protocol}://${context.host}`;
}

function publicLeaseOrigin(request: Request, port: number): string {
  const context = publicRequestContext(request);
  const hostname = hostnameWithoutPort(context.host);
  return `${context.protocol}://${hostForOrigin(hostname)}:${port}`;
}

function publicRequestHost(request: Request): string {
  return request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || new URL(request.url).host;
}

function publicRequestContext(request: Request): PublicRequestContext {
  const previewOrigin = request.headers.get(publicOriginHeader);
  if (previewOrigin) {
    const origin = new URL(previewOrigin);
    return { protocol: origin.protocol.slice(0, -1), host: origin.host, port: origin.port || (origin.protocol === "https:" ? "443" : "80") };
  }
  const url = new URL(request.url);
  const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "");
  const host = publicRequestHost(request);
  const port = new URL(`${protocol}://${host}`).port || (protocol === "https" ? "443" : "80");
  return { protocol, host, port };
}

function hostnameWithoutPort(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    if (host.startsWith("[") && host.includes("]")) return host.slice(1, host.indexOf("]"));
    const parts = host.split(":");
    return parts.length === 2 ? parts[0]! : host;
  }
}

function hostForOrigin(host: string): string {
  const normalized = host === "0.0.0.0" ? "127.0.0.1" : host;
  return normalized.includes(":") && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
}

function websocketTarget(target: URL): string {
  const url = new URL(target);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function websocketProtocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

async function openUpstreamSocket(target: string, headers: Headers, protocols: string[]): Promise<WebSocket> {
  // SAFETY: Bun supports the options constructor at runtime although DOM declarations omit it.
  const WebSocketWithOptions = WebSocket as typeof WebSocket & (new (url: string | URL, options: Bun.WebSocketOptions) => WebSocket);
  const upstream = new WebSocketWithOptions(target, { headers: Object.fromEntries(headers), protocols, proxy: "" });
  upstream.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      upstream.close();
      reject(new Error("Workspace app WebSocket connection timed out"));
    }, 5_000);
    upstream.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    upstream.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Workspace app WebSocket connection failed"));
    }, { once: true });
  });
  return upstream;
}

function openAppSocket(ws: ServerWebSocket<AppSocketData>): void {
  ws.data.lease.activeConnections += 1;
  ws.data.lease.lastUsedAt = Date.now();
  ws.data.upstream.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => ws.send(event.data));
  ws.data.upstream.addEventListener("close", (event: CloseEvent) => closeWebSocket(ws, event.code, event.reason));
  ws.data.upstream.addEventListener("error", () => ws.close(1011, "Upstream WebSocket failed"));
}

function handleAppSocketMessage(ws: ServerWebSocket<AppSocketData>, message: string | Buffer): void {
  const payload = Buffer.isBuffer(message) ? new Uint8Array(message).slice().buffer : message;
  ws.data.upstream.send(payload);
}

function closeAppSocket(ws: ServerWebSocket<AppSocketData>, code: number, reason: string): void {
  if (ws.data.upstream.readyState <= WebSocket.OPEN) closeWebSocket(ws.data.upstream, code, reason);
  ws.data.lease.activeConnections -= 1;
  ws.data.lease.lastUsedAt = Date.now();
}

function adaptWorkspaceEmbedding(response: Response): Response {
  const headers = new Headers(response.headers);
  let changed = headers.has("x-frame-options");
  headers.delete("x-frame-options");
  for (const name of ["content-security-policy", "content-security-policy-report-only"]) {
    const policy = headers.get(name);
    if (!policy) continue;
    const directives = policy.split(";").map((directive) => directive.trim()).filter((directive) => directive && !directive.toLowerCase().startsWith("frame-ancestors"));
    if (directives.length) headers.set(name, directives.join("; "));
    else headers.delete(name);
    changed = true;
  }
  return changed ? new Response(response.body, { status: response.status, statusText: response.statusText, headers }) : response;
}

export function normalizeDecodedFetchResponse(response: Response): Response {
  const contentEncoding = response.headers.get("content-encoding");
  if (!contentEncoding || contentEncoding.toLowerCase() === "identity") return response;
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("content-md5");
  headers.delete("content-digest");
  headers.delete("repr-digest");
  const etag = headers.get("etag");
  if (etag && !etag.trimStart().startsWith("W/")) headers.delete("etag");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function ingressError(error: Error): Response {
  const category = errorCategory(error);
  const message = errorMessage(error);
  if (error instanceof UnknownWorkspaceAppError) return textResponse(`Workspace app does not exist: ${error.app.appKey}. Check or recreate the app.`, 404);
  if (category === "unknown_workspace") return textResponse(`${message}. Check whether the workspace was deleted.`, 404);
  if (category === "stopped_workspace") return textResponse(message, 503);
  if (category === "ineligible_port") return textResponse(`${message}. Choose a documented preview port.`, 400);
  if (category === "capacity_exhausted") return textResponse(message, 507);
  if (category === "connection_refused") return textResponse(`Workspace app connection was refused: ${message}. Verify that the service is listening.`, 503);
  if (category === "connection_timeout") return textResponse(`Workspace app connection timed out: ${message}. Check the service and workspace networking.`, 504);
  if (category === "unsupported_target") return textResponse(message, 422);
  if (category === "malformed_upstream") return textResponse(`Workspace app returned malformed HTTP behavior: ${message}`, 502);
  return textResponse(`Workspace app could not be reached: ${message}`, 502);
}

function errorCategory(error: Error): string {
  if (error instanceof UnknownWorkspaceAppError) return "unknown_app";
  if (error instanceof StoppedWorkspaceError) return "stopped_workspace";
  const message = errorMessage(error);
  if (/workspace.*not found|no such container/i.test(message)) return "unknown_workspace";
  if (/unsupported workspace preview port|ineligible port|not published for browser previews/i.test(message)) return "ineligible_port";
  if (/capacity exhausted|no browser origins available/i.test(message)) return "capacity_exhausted";
  if (/ECONNREFUSED|connection refused|Unable to connect|connection failed/i.test(message)) return "connection_refused";
  if (/timeout|timed out/i.test(message)) return "connection_timeout";
  if (/does not support WebSockets|unsupported target/i.test(message)) return "unsupported_target";
  if (/fetch failed|invalid HTTP|malformed/i.test(message)) return "malformed_upstream";
  return "routing_failure";
}

function textResponse(message: string, status: number): Response {
  return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function errorMessage(error: Error): string {
  return error.message;
}

function appIdentity(app: WorkspaceAppRef): string {
  return `${app.workspaceId}\0${app.appKey}`;
}

function sameApp(left: WorkspaceAppRef, right: WorkspaceAppRef): boolean {
  return left.workspaceId === right.workspaceId && left.appKey === right.appKey;
}

function logIngress(event: string, app: WorkspaceAppRef, details: IngressLogDetails): void {
  console.info(JSON.stringify({ subsystem: "workspace-ingress", event, workspaceId: app.workspaceId, appKey: app.appKey, ...details }));
}

function isAddressInUse(error: Error): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}
