import type { WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { ensureDefaultWorkspaceAgent, listWorkspaceAgents, type WorkspaceAgentInfo } from "./session-store.ts";
import { renderAgentPane } from "./render.ts";

export async function listOrCreateWorkspaceAgents(workspaceId: string): Promise<WorkspaceAgentInfo[]> {
  const agents = await listWorkspaceAgents(workspaceId);
  return agents.length > 0 ? agents : [await ensureDefaultWorkspaceAgent(workspaceId)];
}

export function renderWorkspaceAgentTabs(workspaceId: string, agents: WorkspaceAgentInfo[]): WorkspaceTabContribution[] {
  return agents.map((agent, index) => ({
    key: `agent:${agent.label}`,
    label: agent.label,
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

