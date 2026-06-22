import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { createNextWorkspaceAgent, ensureDefaultWorkspaceAgent, listWorkspaceAgents, type WorkspaceAgentInfo } from "./session-store.ts";
import { getWorkspaceAgentRuntime } from "./runtime.ts";
import { agentTabKey, renderAgentPane, type AgentStatsView } from "./render.ts";
import { getConfiguredAgentModels, setActiveAgentModel, setModelThinkingLevel } from "./pi-config-models.ts";
import { handleAgentRequest } from "./routes.ts";
import type { AtelierEventBus } from "@atelier/core";
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

export async function renderWorkspaceAgentTabs(workspaceId: string, agents: WorkspaceAgentInfo[]): Promise<WorkspaceTabContribution[]> {
  return await Promise.all(agents.map(async (agent, index) => ({
    key: agentTabKey(agent.label),
    label: agent.label,
    // The pane renders as an empty shell: the SSE snapshot fills in the
    // transcript, stats, and prompt actions on connect.
    paneHtml: await renderAgentPane(
      { workspaceId, label: agent.label },
      agent,
      { transcriptHtml: "", busy: false, stats: emptyStats },
      { active: index === 0 },
    ),
  })));
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

async function preferredNewAgentModel(): Promise<string | undefined> {
  const configuredModels = await getConfiguredAgentModels();
  const active = configuredModels.find((model) => model.active) ?? configuredModels[0];
  return active ? `${active.provider}::${active.id}` : undefined;
}

async function applyPreferredNewAgentModel(agent: WorkspaceAgentInfo, events?: unknown): Promise<void> {
  const model = await preferredNewAgentModel();
  const [provider, modelId] = String(model ?? "").split("::");
  if (!provider || !modelId) return;
  await (await getWorkspaceAgentRuntime(agent, { events: events as AtelierEventBus | undefined })).setModel(provider, modelId);
}

export async function rememberPreferredNewAgentModel(model: string, thinkingLevel?: string): Promise<void> {
  const [provider, modelId] = String(model ?? "").split("::");
  if (provider && modelId) {
    await setActiveAgentModel(provider, modelId);
    if (thinkingLevel) await setModelThinkingLevel(provider, modelId, thinkingLevel);
  }
}

export const agentWorkspaceModule: WorkspaceModule = {
  id: "agent",
  staticFiles: agentStaticFiles,
  commands: [{
    id: "agent.create",
    async execute({ workspaceId, events }) {
      const agent = await createNextWorkspaceAgent(workspaceId);
      await applyPreferredNewAgentModel(agent, events);
      return { createdTabKey: agentTabKey(agent.label) };
    },
  }],
  routes: [{
    handle(request, url, context) {
      return handleAgentRequest(request, url, { events: context.events as AtelierEventBus | undefined });
    },
  }],
  tabs: [{
    owns: (tabKey) => tabKey.startsWith("agent:"),
  }],
  async attachToWorkspace({ workspaceId, sourceRepositoryId }) {
    const agents = await listOrCreateWorkspaceAgents(workspaceId);
    return {
      tabs: await renderWorkspaceAgentTabs(workspaceId, agents),
      workspaceCommands: sourceRepositoryId ? [...agentWorkspaceCommands, sourceRepoAgentWorkspaceCommand] : agentWorkspaceCommands,
    };
  },
};
