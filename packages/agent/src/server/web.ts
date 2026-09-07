import { handleUsageRequest, renderUsagePaneAction } from "./usage-web.ts";
import { usageOpenApiPaths } from "./usage-openapi.ts";
import { resolveAgentConversation } from "./delegation.ts";
import type { WorkspaceAgentTabProvider, WorkspaceCommandContribution, WorkspaceModule } from "@atelier/shared";
import {
  createDeleteCurrentWorkspaceTool,
  registerWorkspaceAgentTool,
} from "./tools.ts";
import { createAgentTermSocketSession } from "./bash-tmux.ts";
import { getWorkspaceAgentRuntime, closeWorkspaceAgentConversation, removeWorkspaceAgentRuntimes, restoreWorkspaceAgentRuntime, subscribeWorkspaceViewBusy } from "./runtime.ts";
import { registerAgentEvents } from "./agent-events.ts";
import { handleAgentRequest } from "./routes.ts";
import { workspaceFileEndpoint } from "./workspace-files.ts";
import { resolveWorkspacePortProxyTarget } from "./workspace-proxy.ts";
import { archiveWorkspaceAgentConversation, createNextWorkspaceAgentConversation, ensureDefaultWorkspaceAgentConversation, listWorkspaceAgentConversations, sessionShareDir, sessionShareKeyForInit, sessionShareMountPath, type WorkspaceAgentConversationInfo } from "./session-store.ts";
import { renderWorkspaceCompletionCatalog } from "./completion-catalog.ts";
import { agentConversationKey } from "./render-context.ts";
import { renderAgentCompletionCatalogTurboStream, renderAgentPane } from "./render-composer.ts";
import { resolveNewWorkspaceAgentModel } from "./model-state.ts";
import { createKeyedOperationQueue, dockerHostAtelierDataPath, getAtelierRuntimeContext, AtelierCoreError, type AtelierEventBus } from "@atelier/core";
import { agentStaticFiles } from "./static.ts";
import { mkdir } from "node:fs/promises";
import { removeWorkspaceInitialPromptDrafts } from "./initial-prompt-draft.ts";
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

let agentEvents: AtelierEventBus | undefined;

export function createWorkspaceAgentTabProvider(dependencies: {
  list(workspaceId: string): Promise<readonly WorkspaceAgentConversationInfo[]>;
  render(conversation: WorkspaceAgentConversationInfo): Promise<string>;
  dispose(workspaceId: string, conversationId: string): Promise<void>;
  restore(workspaceId: string, conversationId: string): void;
  archive(conversation: WorkspaceAgentConversationInfo): Promise<void>;
}): WorkspaceAgentTabProvider {
  const serializedClose = createKeyedOperationQueue();

  return {
    async list({ workspaceId }) {
      return (await dependencies.list(workspaceId)).map(({ conversationId, title }) => ({ id: conversationId, title }));
    },

    async render({ workspaceId, conversationId }) {
      const conversation = (await dependencies.list(workspaceId)).find((candidate) => candidate.conversationId === conversationId);
      if (!conversation) throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${conversationId}`);
      return await dependencies.render(conversation);
    },

    async close({ workspaceId, conversationId }) {
      await serializedClose(workspaceId, async () => {
        const conversations = await dependencies.list(workspaceId);
        const conversation = conversations.find((candidate) => candidate.conversationId === conversationId);
        if (!conversation) throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${conversationId}`);
        if (conversations.length === 1) throw new AtelierCoreError("last_agent_conversation", "The last Agent conversation cannot be closed");
        try {
          await dependencies.dispose(workspaceId, conversationId);
          await dependencies.archive(conversation);
        } catch (error) {
          dependencies.restore(workspaceId, conversationId);
          throw error;
        }
      });
    },
  };
}

export const workspaceAgentTabProvider = createWorkspaceAgentTabProvider({
  list: listOrCreateWorkspaceAgentConversations,
  async render(conversation) {
    const runtime = await getWorkspaceAgentRuntime(conversation, { events: agentEvents });
    const [state, completionCatalog] = await Promise.all([
      runtime.paneState(),
      renderWorkspaceCompletionCatalog(conversation.workspaceId),
    ]);
    return await renderAgentPane(
      { workspaceId: conversation.workspaceId, conversationId: conversation.conversationId },
      conversation,
      state,
      completionCatalog,
    );
  },
  dispose: closeWorkspaceAgentConversation,
  restore: restoreWorkspaceAgentRuntime,
  archive: archiveWorkspaceAgentConversation,
});

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
  const model = sourceRuntime?.currentModel() ?? await resolveNewWorkspaceAgentModel();
  const targetRuntime = await getWorkspaceAgentRuntime(agent, runtimeOptions);
  if (model) await targetRuntime.setModel(model.provider, model.id);
  if (sourceRuntime) await targetRuntime.setThinkingLevel(sourceRuntime.currentThinkingLevel());
  await events?.emit("workspace_agent_view_invalidated", { workspaceId: agent.workspaceId, conversationId: agent.conversationId });
}

export const agentWorkspaceModule: WorkspaceModule = {
  id: "agent",
  cableChannels: [{
    name: "agent",
    async subscribe(identifier, listener, events) {
      if (identifier.channel !== "agent") throw new Error("Invalid Agent channel identifier");
      const agent = await resolveAgentConversation(identifier.workspaceId, identifier.conversationId, events);
      const runtime = await getWorkspaceAgentRuntime(agent, { events });
      return runtime.subscribeLivePresentation(listener);
    },
  }],
  staticFiles: agentStaticFiles,
  renderWorkspacePaneActions: renderUsagePaneAction,
  openApiPaths: {
    "/agent-notifications/public-key": { get: {
      summary: "Get this Atelier installation's VAPID public key for browser PushManager subscription",
      responses: { "200": { description: "Public application-server key", content: { "application/json": { schema: { type: "object", properties: { publicKey: { type: "string" } } } } } } },
    } },
    "/workspaces/{id}/agents/{conversationId}/notification": {
      parameters: ["id", "conversationId"].map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
      get: {
        summary: "Get the current turn's one-shot notification state",
        responses: { "200": { description: "Current turnId (null when idle), busy and armed; HTML clients receive the header control", content: { "application/json": { schema: { type: "object", properties: { turnId: { type: ["string", "null"] }, busy: { type: "boolean" }, armed: { type: "boolean" } } } } } } },
      },
      post: {
        summary: "Arm or cancel a native Web Push notification for this exact running turn",
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", required: ["turnId", "enabled"], properties: {
            turnId: { type: "string" }, enabled: { type: "boolean" },
            subscription: { type: "object", description: "Required when enabled; PushSubscription.toJSON() from the receiving device", required: ["endpoint", "keys"], properties: { endpoint: { type: "string" }, keys: { type: "object", required: ["p256dh", "auth"], properties: { p256dh: { type: "string" }, auth: { type: "string" } } } } },
          },
        } } } },
        responses: { "200": { description: "Notification state updated; JSON or Turbo Stream according to Accept" }, "409": { description: "The requested turn is no longer running" }, "422": { description: "Invalid notification intent or unsupported push service" } },
      },
    },
    ...usageOpenApiPaths,
    "/workspaces/{id}/agents/{conversationId}/reveal/{target}": { get: {
      summary: "Reveal a transcript item by stable key or contributed anchor",
      parameters: ["id", "conversationId", "target"].map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
      responses: { "200": { description: "Server-rendered transcript with the target's lazy ancestors expanded", content: { "text/vnd.turbo-stream.html": { schema: { type: "string" } } } } },
    } },
  },
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
  routes: [{ handle: handleUsageRequest }, {
    async handle(request, url, context) {
      // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
      return handleAgentRequest(request, url, { events: context.events as AtelierEventBus | undefined });
    },
  }],
  agentTabs: workspaceAgentTabProvider,
  initialize(context) {
    // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
    const events = context.events as AtelierEventBus;
    agentEvents = events;
    registerAgentEvents(events);
    registerSessionShareMountEvents(events);
    events.on("workspace_agent_turn_finished", async ({ workspaceId, conversationId }) => {
      context.registry.markViewAttention(workspaceId, agentConversationKey(conversationId));
      context.broadcastWorkspace(workspaceId, await renderAgentCompletionCatalogTurboStream(workspaceId));
    });
    context.registerProvisioningHook({
      id: "workspace.agent",
      label: "Prepare default agent",
      async run({ workspaceId, creationContext }) {
        await ensureDefaultWorkspaceAgentConversation(workspaceId, { topic: creationContext?.agent?.initialPrompt });
      },
    });
    context.registerSocketHandler(createAgentTermSocketSession);
    context.registerWorkspaceAppResolver(async (app, requestUrl) => {
      if (app.appKey === "file") {
        return {
          kind: "fetch",
          fetch: (request) => workspaceFileEndpoint(app.workspaceId, decodeURIComponent(new URL(request.url).pathname), request),
        };
      }
      const portMatch = app.appKey.match(/^port-(\d+)$/);
      if (!portMatch) return undefined;
      return {
        kind: "http",
        target: await resolveWorkspacePortProxyTarget(app.workspaceId, Number(portMatch[1]), requestUrl.pathname, requestUrl.search),
      };
    });
    subscribeWorkspaceViewBusy(({ workspaceId, viewKey, busy }) => context.registry.setViewBusy(workspaceId, viewKey, busy));
    context.onWorkspaceRemoved(removeWorkspaceAgentRuntimes);
    context.onWorkspaceRemoved(removeWorkspaceInitialPromptDrafts);
    registerWorkspaceAgentTool("delete_current_workspace", (workspaceId) => createDeleteCurrentWorkspaceTool(workspaceId, async (force) => await context.deleteCurrentWorkspace(workspaceId, force)));
  },
  attachToWorkspace() {
    return { commands: [...agentWorkspaceCommands, projectAgentWorkspaceCommand] };
  },
};
