export interface WorkspaceAppHost {
  appKey: string;
  workspaceId: string;
}

export type WorkspaceAppTargetResolver = (app: WorkspaceAppHost, requestUrl: URL) => Promise<URL> | URL;
export type WorkspaceAppResponseTransformer = (app: WorkspaceAppHost, response: Response) => Promise<Response> | Response;

export function parseWorkspaceAppHost(hostHeader: string | null): WorkspaceAppHost | undefined {
  const host = (hostHeader ?? "").split(":")[0]?.toLowerCase() ?? "";
  const label = host.split(".")[0] ?? "";
  const separator = label.lastIndexOf("--");
  if (separator <= 0 || separator === label.length - 2) return undefined;
  const appKey = label.slice(0, separator);
  const workspaceId = label.slice(separator + 2);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(appKey) || !/^[a-z0-9][a-z0-9_.-]*$/.test(workspaceId)) return undefined;
  return { appKey, workspaceId };
}

function stripHopByHop(headers: Headers): Headers {
  const next = new Headers(headers);
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]) next.delete(name);
  return next;
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
    headers.set("host", request.headers.get("host") ?? target.host);
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
    return transformResponse ? await transformResponse(app, response) : response;
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
