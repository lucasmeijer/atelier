import type { WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { deleteWorkspaceTerminal, listWorkspaceTerminals, type WorkspaceTerminalListResult } from "./workspace-terminals.ts";
import {
  domId,
  renderTerminalPane,
  renderTerminalTab,
} from "./render.ts";

export type HtmlResponseInit = Omit<ResponseInit, "headers"> & { headers?: Record<string, string> };

export function jsonResponse(body: unknown, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function turboStreamResponse(body: string, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/vnd.turbo-stream.html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

export function wantsTurboStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
}

export function renderWorkspaceTerminalTabs(workspaceId: string, terminals: WorkspaceTerminalListResult["terminals"]): WorkspaceTabContribution[] {
  return terminals.map((terminal) => ({
    key: `terminal:${terminal.title}`,
    tabHtml: renderTerminalTab(workspaceId, terminal.title),
    paneHtml: renderTerminalPane(workspaceId, terminal.title),
  }));
}

export const terminalWorkspaceModule: WorkspaceModule = {
  id: "terminal",
  async attachToWorkspace({ workspaceId }) {
    const { terminals } = await listWorkspaceTerminals(workspaceId);
    return {
      tabs: renderWorkspaceTerminalTabs(workspaceId, terminals),
      tabActions: [{ key: "terminal:create", label: "New Terminal" }],
    };
  },
};

export async function deleteTerminalEndpoint(workspaceId: string, title: string, request: Request): Promise<Response> {
  await deleteWorkspaceTerminal(workspaceId, title);
  if (wantsTurboStream(request)) {
    return turboStreamResponse(`<turbo-stream action="remove" target="${domId("terminal_tab", workspaceId, title)}"></turbo-stream><turbo-stream action="remove" target="${domId("terminal_pane", workspaceId, title)}"></turbo-stream><turbo-stream action="append" target="body"><template><div data-controller="activate-tab" data-activate-tab-tab-value="agent"></div></template></turbo-stream>`);
  }
  return jsonResponse(null);
}
