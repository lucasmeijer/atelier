import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { ensureDefaultWorkspaceAgent, listWorkspaceAgents, type WorkspaceAgentInfo } from "./session-store.ts";
import { agentTabKey, renderAgentPane, type AgentStatsView } from "./render.ts";
import { agentStaticFiles } from "./static.ts";

export async function listOrCreateWorkspaceAgents(workspaceId: string): Promise<WorkspaceAgentInfo[]> {
  const agents = await listWorkspaceAgents(workspaceId);
  return agents.length > 0 ? agents : [await ensureDefaultWorkspaceAgent(workspaceId)];
}

const emptyStats: AgentStatsView = {
  contextPercent: null,
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  modelName: undefined,
  provider: undefined,
  thinkingLevel: "off",
  thinkingLevels: [],
  models: [],
};

export function renderWorkspaceAgentTabs(workspaceId: string, agents: WorkspaceAgentInfo[]): WorkspaceTabContribution[] {
  return agents.map((agent, index) => ({
    key: agentTabKey(agent.label),
    label: agent.label,
    // The pane renders as an empty shell: the SSE snapshot fills in the
    // transcript, stats, and prompt actions on connect.
    paneHtml: renderAgentPane(
      { workspaceId, label: agent.label },
      agent,
      { transcriptHtml: "", busy: false, stats: emptyStats },
      { active: index === 0 },
    ),
  }));
}

export const agentWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: "agent.create",
    label: "New Agent",
    surfaces: { ui: { placement: "group-menu" } },
  },
];

const sourceRepoAgentWorkspaceCommand: WorkspaceCommandContribution = {
  id: "agent.launch-source-repo-workspace",
  label: "New Workspace From Source Repo",
  description: "Open the source repository agent workspace prompt.",
  surfaces: { shortcut: { defaultBinding: "Meta+Alt+Quote" } },
};

export const agentWorkspaceModule: WorkspaceModule = {
  id: "agent",
  staticFiles: agentStaticFiles,
  async attachToWorkspace({ workspaceId, sourceRepositoryId }) {
    const agents = await listOrCreateWorkspaceAgents(workspaceId);
    return {
      tabs: renderWorkspaceAgentTabs(workspaceId, agents),
      workspaceCommands: sourceRepositoryId ? [...agentWorkspaceCommands, sourceRepoAgentWorkspaceCommand] : agentWorkspaceCommands,
    };
  },
};
