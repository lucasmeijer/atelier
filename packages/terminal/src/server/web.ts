import type { WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { createWorkspaceTerminal, deleteWorkspaceTerminal, listWorkspaceTerminals, type WorkspaceTerminalListResult } from "./workspace-terminals.ts";
import {
  domId,
  escapeHtml,
  renderInitializingTerminalFooterAction,
  renderInitializingTerminalPane,
  renderInitializingTerminalTab,
  renderTerminalFooterAction,
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

export async function listTerminalTabs(workspaceId: string): Promise<WorkspaceTerminalListResult["terminals"]> {
  return (await listWorkspaceTerminals(workspaceId)).terminals;
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
      tabActions: [{
        key: "terminal:create",
        html: `<form class="contents" id="${escapeHtml(addTerminalFormId(workspaceId))}" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/terminals"><button class="tab muted" type="submit">+ Terminal</button></form>`,
      }],
    };
  },
};

export async function listTerminalsEndpoint(workspaceId: string): Promise<Response> {
  return jsonResponse(await listWorkspaceTerminals(workspaceId));
}

function addTerminalFormId(workspaceId: string): string {
  return `add_terminal_form_${workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function workspacePanesId(workspaceId: string): string {
  return `workspace_panes_${workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function terminalFooterActionsId(workspaceId: string): string {
  return `terminal_footer_actions_${workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function terminalCreationStream(workspaceId: string): Response {
  const token = `initializing_${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      write(`<turbo-stream action="before" target="${escapeHtml(addTerminalFormId(workspaceId))}"><template>${renderInitializingTerminalTab(workspaceId, token)}</template></turbo-stream><turbo-stream action="append" target="${escapeHtml(workspacePanesId(workspaceId))}"><template>${renderInitializingTerminalPane(workspaceId, token)}</template></turbo-stream><turbo-stream action="append" target="${escapeHtml(terminalFooterActionsId(workspaceId))}"><template>${renderInitializingTerminalFooterAction(workspaceId, token)}</template></turbo-stream><turbo-stream action="append" target="body"><template><div data-controller="activate-tab" data-activate-tab-tab-value="terminal:${escapeHtml(token)}"></div></template></turbo-stream>`);
      try {
        const terminal = await createWorkspaceTerminal(workspaceId);
        write(`<turbo-stream action="replace" target="${domId("terminal_tab", workspaceId, token)}"><template>${renderTerminalTab(workspaceId, terminal.title, { active: true })}</template></turbo-stream><turbo-stream action="replace" target="${domId("terminal_pane", workspaceId, token)}"><template>${renderTerminalPane(workspaceId, terminal.title, { autostart: true, active: true })}</template></turbo-stream><turbo-stream action="replace" target="${domId("terminal_footer", workspaceId, token)}"><template>${renderTerminalFooterAction(workspaceId, terminal.title, { active: true })}</template></turbo-stream><turbo-stream action="append" target="body"><template><div data-controller="activate-tab" data-activate-tab-tab-value="terminal:${escapeHtml(terminal.title)}"></div></template></turbo-stream>`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        write(`<turbo-stream action="replace" target="${domId("terminal_tab", workspaceId, token)}"><template><span id="${domId("terminal_tab", workspaceId, token)}" class="tab active">Terminal creation failed</span></template></turbo-stream><turbo-stream action="replace" target="${domId("terminal_pane", workspaceId, token)}"><template><section id="${domId("terminal_pane", workspaceId, token)}" class="tab-pane active" data-tab-pane="terminal:${escapeHtml(token)}"><div class="terminal-pane terminal-initializing"><div class="terminal-bar">Terminal creation failed</div><div class="terminal-loading">${escapeHtml(message)}</div></div></section></template></turbo-stream>`);
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 202, headers: { "content-type": "text/vnd.turbo-stream.html; charset=utf-8" } });
}

export async function createTerminalEndpoint(workspaceId: string, request: Request): Promise<Response> {
  if (wantsTurboStream(request)) return terminalCreationStream(workspaceId);
  return jsonResponse(await createWorkspaceTerminal(workspaceId), { status: 201 });
}

export async function deleteTerminalEndpoint(workspaceId: string, title: string, request: Request): Promise<Response> {
  await deleteWorkspaceTerminal(workspaceId, title);
  if (wantsTurboStream(request)) {
    return turboStreamResponse(`<turbo-stream action="remove" target="${domId("terminal_tab", workspaceId, title)}"></turbo-stream><turbo-stream action="remove" target="${domId("terminal_pane", workspaceId, title)}"></turbo-stream><turbo-stream action="remove" target="${domId("terminal_footer", workspaceId, title)}"></turbo-stream><turbo-stream action="append" target="body"><template><div data-controller="activate-tab" data-activate-tab-tab-value="agent"></div></template></turbo-stream>`);
  }
  return jsonResponse(null);
}
