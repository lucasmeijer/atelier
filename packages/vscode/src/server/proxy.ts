import { getWorkspaceVSCodePort } from "@atelier/core";
import { ensureWorkspaceVSCodeServer } from "./workspace-vscode.ts";

export const vscodeAppKey = "vscode";
export const vscodeContainerPort = 8000;

export interface WorkspaceAppHost {
  appKey: string;
  workspaceId: string;
}

export function parseWorkspaceAppHost(hostHeader: string | null): WorkspaceAppHost | undefined {
  const host = (hostHeader ?? "").split(":")[0]?.toLowerCase() ?? "";
  const suffix = ".localhost";
  if (!host.endsWith(suffix)) return undefined;
  const label = host.slice(0, -suffix.length);
  const separator = label.lastIndexOf("--");
  if (separator <= 0 || separator === label.length - 2) return undefined;
  const appKey = label.slice(0, separator);
  const workspaceId = label.slice(separator + 2);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(appKey) || !/^[a-z0-9][a-z0-9_.-]*$/.test(workspaceId)) return undefined;
  return { appKey, workspaceId };
}

async function targetPortFor(app: WorkspaceAppHost): Promise<number> {
  if (app.appKey !== vscodeAppKey) throw new Error(`unknown workspace app: ${app.appKey}`);
  await ensureWorkspaceVSCodeServer(app.workspaceId);
  return await getWorkspaceVSCodePort(app.workspaceId);
}

function stripHopByHop(headers: Headers): Headers {
  const next = new Headers(headers);
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]) next.delete(name);
  return next;
}

export async function proxyWorkspaceAppRequest(app: WorkspaceAppHost, request: Request): Promise<Response> {
  const hostPort = await targetPortFor(app);
  const source = new URL(request.url);
  const target = new URL(source.pathname + source.search, `http://127.0.0.1:${hostPort}`);
  const headers = stripHopByHop(request.headers);
  headers.set("host", `127.0.0.1:${hostPort}`);
  return await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
}

export async function workspaceAppWebSocketTarget(app: WorkspaceAppHost, pathname: string, search: string): Promise<string> {
  const hostPort = await targetPortFor(app);
  return `ws://127.0.0.1:${hostPort}${pathname}${search}`;
}
