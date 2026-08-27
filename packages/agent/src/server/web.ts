import type { WorkspaceAgentConversationPresentation, WorkspaceCommandContribution, WorkspaceModule } from "@atelier/shared";
import {
  createDeleteCurrentWorkspaceTool,
  // createForkCurrentWorkspaceTool,
  createWorkspaceTool,
  registerWorkspaceAgentTool,
} from "./tools.ts";
import { createAgentTermSocketSession } from "./bash-tmux.ts";
import { getWorkspaceAgentRuntime, isWorkspaceAgentRuntimeReady, removeWorkspaceAgentRuntimes, subscribeWorkspaceViewBusy } from "./runtime.ts";
import { handleAgentRequest, registerAgentEvents, resolveWorkspacePortProxyTarget, workspaceFileEndpoint } from "./routes.ts";
import { createNextWorkspaceAgentConversation, ensureDefaultWorkspaceAgentConversation, listWorkspaceAgentConversations, sessionShareDir, sessionShareKeyForInit, sessionShareMountPath, type WorkspaceAgentConversationInfo } from "./session-store.ts";
import { agentConversationKey, renderAgentPane, renderPendingAgentPane } from "./render.ts";
import { preferredNewWorkspaceAgentModel } from "./model-state.ts";
import { dockerHostAtelierDataPath, getAtelierRuntimeContext, AtelierCoreError, type AtelierEventBus } from "@atelier/core";
import { agentStaticFiles } from "./static.ts";
import { mkdir } from "node:fs/promises";
import { removeInitialPromptDraft } from "./initial-prompt-draft.ts";
import type { WorkspaceDockerMount, WorkspaceInitInstruction } from "@atelier/workspace";

async function listOrCreateWorkspaceAgentConversations(workspaceId: string): Promise<WorkspaceAgentConversationInfo[]> {
  try {
    const conversations = await listWorkspaceAgentConversations(workspaceId);
    return conversations.length > 0 ? conversations : [await ensureDefaultWorkspaceAgentConversation(workspaceId)];
  } catch (error) {
    if (error instanceof AtelierCoreError && error.code === "workspace_not_found") return [];
    throw error;
  }
}

async function renderWorkspaceAgentConversations(workspaceId: string, conversations: WorkspaceAgentConversationInfo[], events?: AtelierEventBus): Promise<WorkspaceAgentConversationPresentation[]> {
  return await Promise.all(conversations.map(async (conversation, index) => {
    const ctx = { workspaceId, label: conversation.label };
    const bodyHtml = isWorkspaceAgentRuntimeReady(conversation)
      ? await renderAgentPane(ctx, conversation, await (await getWorkspaceAgentRuntime(conversation, { events })).paneState(), { visible: index === 0 })
      : await renderPendingAgentPane(ctx, conversation, { visible: index === 0 });
    return { id: conversation.conversationId, title: conversation.title, sourceKey: agentConversationKey(conversation.label), bodyHtml };
  }));
}

export const agentWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: "agent.create",
    label: "New Agent",
    scope: "workspace",
    surfaces: { ui: { placement: "agent-action" } },
  },
];

const projectAgentWorkspaceCommand: WorkspaceCommandContribution = {
  id: "agent.open-launch-composer",
  label: "New Workspace With Same Project",
  description: "Open a LaunchComposer using the current Workspace's Project.",
  scope: "global",
  surfaces: { shortcut: { defaultBinding: "Meta+Alt+Quote" } },
};

type WorkspacePlanEvents = {
  on(eventName: "workspace_plan_prepare", handler: (event: { init?: WorkspaceInitInstruction; plan: { mounts: WorkspaceDockerMount[] } }) => void | Promise<void>): void;
};

function dockerHostSessionShareDir(shareKey: string): string {
  return dockerHostAtelierDataPath(getAtelierRuntimeContext(), "session-shares", shareKey);
}

function registerSessionShareMountEvents(events: AtelierEventBus): void {
  // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
  (events as WorkspacePlanEvents).on("workspace_plan_prepare", async ({ init, plan }) => {
    const shareKey = sessionShareKeyForInit(init);
    await mkdir(sessionShareDir(shareKey), { recursive: true });
    plan.mounts.push({ type: "bind", source: dockerHostSessionShareDir(shareKey), target: sessionShareMountPath, readonly: true });
  });
}

async function applyNewAgentSettings(agent: WorkspaceAgentConversationInfo, source: WorkspaceAgentConversationInfo | undefined, events?: AtelierEventBus): Promise<void> {
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
    async execute({ workspaceId, events }) {
      const sourceConversation = (await listWorkspaceAgentConversations(workspaceId))[0];
      const conversation = await createNextWorkspaceAgentConversation(workspaceId);
      const applySettingsTimer = setTimeout(() => {
        // SAFETY: Workspace commands receive the web server's AtelierEventBus.
        void applyNewAgentSettings(conversation, sourceConversation, events as AtelierEventBus | undefined).catch((error) => console.error("Could not apply settings to new Agent conversation", error));
      }, 0);
      applySettingsTimer.unref?.();
      return { createdAgentConversationId: conversation.conversationId };
    },
  }],
  routes: [{
    handle(request, url, context) {
      // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
      return handleAgentRequest(request, url, { events: context.events as AtelierEventBus | undefined });
    },
  }],
  initialize(context) {
    // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
    const events = context.events as AtelierEventBus;
    registerAgentEvents(events);
    registerSessionShareMountEvents(events);
    events.on("workspace_agent_turn_finished", ({ workspaceId, agentLabel }) => {
      context.registry.setViewUnread(workspaceId, agentConversationKey(agentLabel), true);
    });
    context.registerProvisioningHook({
      id: "workspace.agent",
      label: "Prepare default agent",
      async run({ workspaceId, creationContext }) {
        await ensureDefaultWorkspaceAgentConversation(workspaceId, { topic: creationContext?.agent?.initialPrompt });
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
    subscribeWorkspaceViewBusy(({ workspaceId, viewKey, busy }) => context.registry.setViewBusy(workspaceId, viewKey, busy));
    context.onWorkspaceRemoved(removeWorkspaceAgentRuntimes);
    context.onWorkspaceRemoved(removeInitialPromptDraft);
    registerWorkspaceAgentTool("delete_current_workspace", (workspaceId) => createDeleteCurrentWorkspaceTool(workspaceId, async (force) => await context.deleteCurrentWorkspace(workspaceId, force)));
    registerWorkspaceAgentTool("create_workspace", (workspaceId) => createWorkspaceTool((request) => context.createWorkspaceFromAgent(workspaceId, request)));
    // Temporarily keep workspace forking unavailable to agents; they invoke it too readily.
    // registerWorkspaceAgentTool("fork_current_workspace", (workspaceId) => createForkCurrentWorkspaceTool((request) => context.forkCurrentWorkspaceFromAgent(workspaceId, request)));
  },
  async attachToWorkspace({ workspaceId, events }) {
    try {
      const agents = await listOrCreateWorkspaceAgentConversations(workspaceId);
      return {
        // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
        agentConversations: await renderWorkspaceAgentConversations(workspaceId, agents, events as AtelierEventBus | undefined),
        commands: [...agentWorkspaceCommands, projectAgentWorkspaceCommand],
      };
    } catch (error) {
      if (error instanceof AtelierCoreError && error.code === "workspace_not_found") return { agentConversations: [], commands: [...agentWorkspaceCommands, projectAgentWorkspaceCommand] };
      throw error;
    }
  },
};
