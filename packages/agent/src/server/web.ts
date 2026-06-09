import type { WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { createNextWorkspaceAgent, ensureDefaultWorkspaceAgent, listWorkspaceAgents, type WorkspaceAgentInfo } from "./session-store.ts";
import { escapeHtml, renderAgentPane, renderAgentTab } from "./render.ts";

type HtmlResponseInit = Omit<ResponseInit, "headers"> & { headers?: Record<string, string> };

function jsonResponse(body: unknown, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function turboStreamResponse(body: string, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/vnd.turbo-stream.html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

function wantsTurboStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
}

export async function listOrCreateWorkspaceAgents(workspaceId: string): Promise<WorkspaceAgentInfo[]> {
  const agents = await listWorkspaceAgents(workspaceId);
  return agents.length > 0 ? agents : [await ensureDefaultWorkspaceAgent(workspaceId)];
}

export function renderWorkspaceAgentTabs(workspaceId: string, agents: WorkspaceAgentInfo[]): WorkspaceTabContribution[] {
  return agents.map((agent, index) => ({
    key: `agent:${agent.label}`,
    tabHtml: renderAgentTab(workspaceId, agent, { active: index === 0 }),
    paneHtml: renderAgentPane(workspaceId, agent, { active: index === 0, autostart: index === 0 }),
  }));
}

export const agentWorkspaceModule: WorkspaceModule = {
  id: "agent",
  async attachToWorkspace({ workspaceId }) {
    const agents = await listOrCreateWorkspaceAgents(workspaceId);
    return {
      tabs: renderWorkspaceAgentTabs(workspaceId, agents),
      tabActions: [{ key: "agent:create", label: "New Agent" }],
    };
  },
};

function addAgentFormId(workspaceId: string): string {
  return `add_agent_form_${workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function workspacePanesId(workspaceId: string): string {
  return `workspace_panes_${workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function renderAgentCreationStream(workspaceId: string, agent: WorkspaceAgentInfo): Response {
  return turboStreamResponse(`<turbo-stream action="before" target="${escapeHtml(addAgentFormId(workspaceId))}"><template>${renderAgentTab(workspaceId, agent, { active: true })}</template></turbo-stream><turbo-stream action="append" target="${escapeHtml(workspacePanesId(workspaceId))}"><template>${renderAgentPane(workspaceId, agent, { active: true, autostart: true })}</template></turbo-stream><turbo-stream action="append" target="body"><template><div data-controller="activate-tab" data-activate-tab-tab-value="agent:${escapeHtml(agent.label)}"></div></template></turbo-stream>`, { status: 201 });
}

export async function createAgentEndpoint(workspaceId: string, request: Request): Promise<Response> {
  const agent = await createNextWorkspaceAgent(workspaceId);
  if (wantsTurboStream(request)) return renderAgentCreationStream(workspaceId, agent);
  return jsonResponse(agent, { status: 201 });
}
