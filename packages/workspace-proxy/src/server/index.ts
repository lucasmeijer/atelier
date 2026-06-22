export interface WorkspaceAppHost {
  appKey: string;
  workspaceId: string;
}

export {
  defaultPublicProxyPortRange,
  ensureWorkspacePublicProxyRoute,
  listWorkspacePublicProxyRoutes,
  publicProxyPortRangeFromEnv,
  readWorkspacePublicProxyState,
  releaseWorkspacePublicProxyRoutes,
  writeWorkspacePublicProxyState,
  type PublicProxyPortRange,
  type WorkspacePublicProxyRoute,
  type WorkspacePublicProxyState,
} from "./route-state.ts";

export type WorkspaceAppTargetResolver = (app: WorkspaceAppHost, requestUrl: URL) => Promise<URL> | URL;
export type WorkspaceAppResponseTransformer = (app: WorkspaceAppHost, response: Response, request: Request) => Promise<Response> | Response;

function stripHopByHop(headers: Headers): Headers {
  const next = new Headers(headers);
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]) next.delete(name);
  return next;
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

export async function proxyWorkspaceAppRequest(
  app: WorkspaceAppHost,
  request: Request,
  resolveTarget: WorkspaceAppTargetResolver,
  transformResponse?: WorkspaceAppResponseTransformer,
): Promise<Response> {
  try {
    const source = new URL(request.url);
    const target = await resolveTarget(app, source);
    const headers = stripHopByHop(request.headers);
    const sourceProto = publicWorkspaceAppProtocol(request, source);
    const sourceHost = publicWorkspaceAppHost(request, source);
    headers.set("host", sourceHost);
    headers.set("x-forwarded-host", sourceHost);
    headers.set("x-forwarded-proto", sourceProto);
    const sourcePort = publicWorkspaceAppPort(sourceHost, sourceProto);
    if (sourcePort) headers.set("x-forwarded-port", sourcePort);
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
    return transformResponse ? await transformResponse(app, response, request) : response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Workspace app proxy error: ${message}\n`, { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

export async function workspaceAppWebSocketTarget(app: WorkspaceAppHost, pathname: string, search: string, resolveTarget: WorkspaceAppTargetResolver): Promise<string> {
  const target = await resolveTarget(app, new URL(`${pathname}${search}`, "http://workspace-app.localhost"));
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}
