import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import {
  createDeleteCurrentWorkspaceTool,
  // createForkCurrentWorkspaceTool,
  createWorkspaceTool,
  registerWorkspaceAgentTool,
} from "./tools.ts";
import { createAgentTermSocketSession } from "./bash-tmux.ts";
import { getWorkspaceAgentRuntime, isWorkspaceAgentRuntimeReady, subscribeWorkspaceTabBusy } from "./runtime.ts";
import { handleAgentRequest, registerAgentEvents, resolveWorkspacePortProxyTarget, workspaceFileEndpoint } from "./routes.ts";
import { createNextWorkspaceAgent, ensureDefaultWorkspaceAgent, listWorkspaceAgents, sessionShareDir, sessionShareKeyForInit, sessionShareMountPath, type WorkspaceAgentInfo } from "./session-store.ts";
import { agentTabKey, renderAgentPane, renderPendingAgentPane } from "./render.ts";
import { preferredNewWorkspaceAgentModel } from "./model-state.ts";
import { dockerHostAtelierDataPath, getAtelierRuntimeContext, AtelierCoreError, type AtelierEventBus } from "@atelier/core";
import { agentStaticFiles } from "./static.ts";
import { mkdir } from "node:fs/promises";
import type { WorkspacePlanPrepareEvent } from "@atelier/workspace";

async function listOrCreateWorkspaceAgents(workspaceId: string): Promise<WorkspaceAgentInfo[]> {
  try {
    const agents = await listWorkspaceAgents(workspaceId);
    return agents.length > 0 ? agents : [await ensureDefaultWorkspaceAgent(workspaceId)];
  } catch (error) {
    if (error instanceof AtelierCoreError && error.code === "workspace_not_found") return [];
    throw error;
  }
}

async function renderWorkspaceAgentTabs(workspaceId: string, agents: WorkspaceAgentInfo[], events?: AtelierEventBus, renderPaneKeys?: ReadonlySet<string>): Promise<WorkspaceTabContribution[]> {
  return await Promise.all(agents.map(async (agent, index) => {
    const ctx = { workspaceId, label: agent.label };
    const key = agentTabKey(agent.label);
    if (renderPaneKeys && !renderPaneKeys.has(key)) return { key, label: agent.label };
    const paneHtml = isWorkspaceAgentRuntimeReady(agent)
      ? await renderAgentPane(ctx, agent, await (await getWorkspaceAgentRuntime(agent, { events })).paneState(), { visible: index === 0 })
      : await renderPendingAgentPane(ctx, agent, { visible: index === 0 });
    return {
      key,
      label: agent.label,
      paneHtml,
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

function dockerHostSessionShareDir(shareKey: string): string {
  return dockerHostAtelierDataPath(getAtelierRuntimeContext(), "session-shares", shareKey);
}

function registerSessionShareMountEvents(events: AtelierEventBus): void {
  events.on("workspace_plan_prepare", async ({ init, plan }: WorkspacePlanPrepareEvent) => {
    const shareKey = sessionShareKeyForInit(init);
    await mkdir(sessionShareDir(shareKey), { recursive: true });
    plan.mounts.push({ type: "bind", source: dockerHostSessionShareDir(shareKey), target: sessionShareMountPath, readonly: true });
  });
}

async function applyNewAgentSettings(agent: WorkspaceAgentInfo, source: WorkspaceAgentInfo | undefined, events?: AtelierEventBus): Promise<void> {
  const runtimeOptions = { events };
  const sourceRuntime = source ? await getWorkspaceAgentRuntime(source, runtimeOptions) : undefined;
  const model = sourceRuntime?.currentModel() ?? await preferredNewWorkspaceAgentModel();
  const targetRuntime = await getWorkspaceAgentRuntime(agent, runtimeOptions);
  if (model) await targetRuntime.setModel(model.provider, model.id);
  if (sourceRuntime) await targetRuntime.setThinkingLevel(sourceRuntime.currentThinkingLevel());
}

export const agentWorkspaceModule: WorkspaceModule = {
  id: "agent",
  staticFiles: agentStaticFiles,
  commands: [{
    id: "agent.create",
    async execute({ workspaceId, events, activeTabKey }) {
      const sourceLabel = activeTabKey?.startsWith("agent:") ? activeTabKey.slice("agent:".length) : undefined;
      const sourceAgent = sourceLabel ? (await listWorkspaceAgents(workspaceId)).find((candidate) => candidate.label === sourceLabel) : undefined;
      const agent = await createNextWorkspaceAgent(workspaceId);
      const applySettingsTimer = setTimeout(() => {
        // SAFETY: Workspace commands receive the web server's AtelierEventBus.
        void applyNewAgentSettings(agent, sourceAgent, events as AtelierEventBus | undefined).catch((error) => console.error("Could not apply settings to new agent", error));
      }, 0);
      applySettingsTimer.unref?.();
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
    registerAgentEvents(events);
    registerSessionShareMountEvents(events);
    events.on("workspace_agent_turn_finished", ({ workspaceId, agentLabel }) => {
      context.registry.setTabUnread(workspaceId, agentTabKey(agentLabel), true);
    });
    context.registerProvisioningHook({
      id: "workspace.agent",
      label: "Prepare default agent",
      async run({ workspaceId, creationContext }) {
        await ensureDefaultWorkspaceAgent(workspaceId, { topic: creationContext?.agent?.initialPrompt });
      },
    });
    context.registerSocketHandler(createAgentTermSocketSession);
    context.registerWorkspaceAppHandler({
      matches: (app) => app.appKey === "file" || /^port-(\d+)$/.test(app.appKey),
      handleRequest: (app, request, url) => app.appKey === "file" ? workspaceFileEndpoint(app.workspaceId, decodeURIComponent(url.pathname), request) : undefined,
      resolveTarget: (app, requestUrl) => {
        const portMatch = app.appKey.match(/^port-(\d+)$/);
        return portMatch ? resolveWorkspacePortProxyTarget(app.workspaceId, Number(portMatch[1]), requestUrl.pathname, requestUrl.search) : undefined;
      },
    });
    subscribeWorkspaceTabBusy(({ workspaceId, tabKey, busy }) => context.registry.setTabBusy(workspaceId, tabKey, busy));
    registerWorkspaceAgentTool("delete_current_workspace", (workspaceId) => createDeleteCurrentWorkspaceTool(workspaceId, async (force) => await context.deleteCurrentWorkspace(workspaceId, force)));
    registerWorkspaceAgentTool("create_workspace", (workspaceId) => createWorkspaceTool((request) => context.createWorkspaceFromAgent(workspaceId, request)));
    // Temporarily keep workspace forking unavailable to agents; they invoke it too readily.
    // registerWorkspaceAgentTool("fork_current_workspace", (workspaceId) => createForkCurrentWorkspaceTool((request) => context.forkCurrentWorkspaceFromAgent(workspaceId, request)));
  },
  async attachToWorkspace({ workspaceId, init, events, renderPaneKeys }) {
    const hasProject = typeof init === "object" && init !== null && "type" in init && init.type === "project.git";
    try {
      const agents = await listOrCreateWorkspaceAgents(workspaceId);
      return {
        tabs: await renderWorkspaceAgentTabs(workspaceId, agents, events as AtelierEventBus | undefined, renderPaneKeys),
        commands: hasProject ? [...agentWorkspaceCommands, projectAgentWorkspaceCommand] : agentWorkspaceCommands,
      };
    } catch (error) {
      if (error instanceof AtelierCoreError && error.code === "workspace_not_found") return { tabs: [], commands: hasProject ? [...agentWorkspaceCommands, projectAgentWorkspaceCommand] : agentWorkspaceCommands };
      throw error;
    }
  },
};
