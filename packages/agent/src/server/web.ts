import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { createDeleteCurrentWorkspaceTool, registerWorkspaceAgentTool, type DeleteCurrentWorkspaceResult } from "./tools.ts";
import { closeAgentTermSocket, handleAgentTermSocketMessage, openAgentTermSocket, validateAgentTermSocket } from "./bash-tmux.ts";
import { getWorkspaceAgentRuntime, subscribeWorkspaceTabBusy } from "./runtime.ts";
import { handleAgentRequest, registerAgentEvents, resolveWorkspacePortProxyTarget, workspaceFileEndpoint } from "./routes.ts";
import { registerPiConfigEvents } from "./pi-config-seed.ts";
import { createNextWorkspaceAgent, ensureDefaultWorkspaceAgent, listWorkspaceAgents, type WorkspaceAgentInfo } from "./session-store.ts";
import { agentTabKey, renderAgentPane, type AgentPaneState } from "./render.ts";
import { modelRefValue, parseModelRef, preferredAgentModel, rememberPreferredAgentModel } from "./model-state.ts";
import { AtelierCoreError, type AtelierEventBus } from "@atelier/core";
import { agentStaticFiles } from "./static.ts";

async function listOrCreateWorkspaceAgents(workspaceId: string): Promise<WorkspaceAgentInfo[]> {
  try {
    const agents = await listWorkspaceAgents(workspaceId);
    return agents.length > 0 ? agents : [await ensureDefaultWorkspaceAgent(workspaceId)];
  } catch (error) {
    if (error instanceof AtelierCoreError && error.code === "workspace_not_found") return [];
    throw error;
  }
}

async function renderWorkspaceAgentTabs(workspaceId: string, agents: WorkspaceAgentInfo[], events?: AtelierEventBus): Promise<WorkspaceTabContribution[]> {
  return await Promise.all(agents.map(async (agent, index) => {
    const state: AgentPaneState = await (await getWorkspaceAgentRuntime(agent, { events })).paneState();
    return {
      key: agentTabKey(agent.label),
      label: agent.label,
      paneHtml: await renderAgentPane(
        { workspaceId, label: agent.label },
        agent,
        state,
        { active: index === 0 },
      ),
    };
  }));
}

export const agentWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: "agent.create",
    label: "New Agent",
    scope: "workspace",
    surfaces: { ui: { placement: "group-menu" } },
  },
];

const projectAgentWorkspaceCommand: WorkspaceCommandContribution = {
  id: "agent.launch-project-workspace",
  label: "New Workspace From Project",
  description: "Open the project agent workspace prompt.",
  scope: "global",
  surfaces: { shortcut: { defaultBinding: "Meta+Alt+Quote" } },
};

async function preferredNewAgentModel(): Promise<string | undefined> {
  const model = await preferredAgentModel();
  return model ? modelRefValue(model) : undefined;
}

async function applyPreferredNewAgentModel(agent: WorkspaceAgentInfo, events?: unknown): Promise<void> {
  const model = parseModelRef(String(await preferredNewAgentModel() ?? ""));
  if (!model) return;
  await (await getWorkspaceAgentRuntime(agent, { events: events as AtelierEventBus | undefined })).setModel(model.provider, model.id);
}

export async function rememberPreferredNewAgentModel(model: string, thinkingLevel?: string): Promise<void> {
  await rememberPreferredAgentModel(model, thinkingLevel);
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
  initialize(context) {
    const events = context.events as AtelierEventBus;
    registerPiConfigEvents(events);
    registerAgentEvents(events);
    events.on("workspace_agent_turn_finished", ({ workspaceId, agentLabel }) => {
      if (context.registry.activeWorkspaceId() !== workspaceId) context.registry.setTabUnread(workspaceId, agentTabKey(agentLabel), true);
    });
    context.registerProvisioningHook({
      id: "workspace.agent",
      label: "Prepare default agent",
      async run({ workspaceId }) {
        await ensureDefaultWorkspaceAgent(workspaceId);
      },
    });
    context.registerSocketHandler({
      validate: (_request, url) => validateAgentTermSocket(url),
      open: (socket) => openAgentTermSocket(socket as Parameters<typeof openAgentTermSocket>[0]),
      message: (socket, message) => handleAgentTermSocketMessage(socket as Parameters<typeof handleAgentTermSocketMessage>[0], message as string | Buffer),
      close: (socket) => closeAgentTermSocket(socket as Parameters<typeof closeAgentTermSocket>[0]),
    });
    context.registerWorkspaceAppHandler({
      matches: (app) => app.appKey === "file" || /^port-(\d+)$/.test(app.appKey),
      handleRequest: (app, request, url) => app.appKey === "file" ? workspaceFileEndpoint(app.workspaceId, decodeURIComponent(url.pathname), request) : undefined,
      resolveTarget: (app, requestUrl) => {
        const portMatch = app.appKey.match(/^port-(\d+)$/);
        return portMatch ? resolveWorkspacePortProxyTarget(app.workspaceId, Number(portMatch[1]), requestUrl.pathname, requestUrl.search) : undefined;
      },
    });
    subscribeWorkspaceTabBusy(({ workspaceId, tabKey, busy }) => context.registry.setTabBusy(workspaceId, tabKey, busy));
    registerWorkspaceAgentTool("delete_current_workspace", (workspaceId) => createDeleteCurrentWorkspaceTool(workspaceId, async (force) => await context.deleteCurrentWorkspace(workspaceId, force) as DeleteCurrentWorkspaceResult));
  },
  async attachToWorkspace({ workspaceId, init, events }) {
    const hasProject = typeof init === "object" && init !== null && "type" in init && init.type === "project.git";
    try {
      const agents = await listOrCreateWorkspaceAgents(workspaceId);
      return {
        tabs: await renderWorkspaceAgentTabs(workspaceId, agents, events as AtelierEventBus | undefined),
        commands: hasProject ? [...agentWorkspaceCommands, projectAgentWorkspaceCommand] : agentWorkspaceCommands,
      };
    } catch (error) {
      if (error instanceof AtelierCoreError && error.code === "workspace_not_found") return { tabs: [], commands: hasProject ? [...agentWorkspaceCommands, projectAgentWorkspaceCommand] : agentWorkspaceCommands };
      throw error;
    }
  },
};
