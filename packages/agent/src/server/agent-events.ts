import type { AtelierEventBus } from "@atelier/core";
import type { AgentWorkspaceParameters } from "@atelier/shared";
import { agentAttachmentDraftId, deliverAttachmentDraft, moveAttachmentDraft, removeAttachmentDraft, validDraftId } from "./attachment-drafts.ts";
import { maybeNameAgentFromPrompt } from "./agent-title-suggestion.ts";
import { stageInitialPrompt } from "./initial-prompt-draft.ts";
import { parseModelRef } from "./model-state.ts";
import { getModelThinkingLevel } from "./pi-config-models.ts";
import { expandPromptTemplate } from "./prompt-templates.ts";
import { getWorkspaceAgentRuntime } from "./runtime.ts";
import { resumeInterruptedAgentSessions } from "./restart-recovery.ts";
import { ensureDefaultWorkspaceAgentConversation } from "./session-store.ts";

export function registerAgentEvents(events: AtelierEventBus): void {
  events.on("atelier_host_started", ({ workspaces }) => {
    void resumeInterruptedAgentSessions(workspaces, events).catch((error) => {
      console.error("Could not inspect interrupted Agent sessions after Atelier restarted", error);
    });
  });
  events.on("workspace_created", async ({ workspaceId, context }) => {
    const agentContext = context?.agent;
    if (!agentContext) return;
    const hasPrompt = !agentContext.initialPromptMode && Boolean(agentContext.initialPrompt?.trim());
    if (hasPrompt) await events.emit("workspace_provision_step", { workspaceId, id: "agent.initial_prompt", label: "Start initial agent task", parentId: "workspace.integrations", status: "running" });
    await initializeWorkspaceAgent(workspaceId, agentContext, events);
    if (hasPrompt) await events.emit("workspace_provision_step", { workspaceId, id: "agent.initial_prompt", label: "Start initial agent task", parentId: "workspace.integrations", status: "done" });
  });
}

async function initializeWorkspaceAgent(workspaceId: string, context: AgentWorkspaceParameters, events: AtelierEventBus): Promise<void> {
  const agent = await ensureDefaultWorkspaceAgentConversation(workspaceId);
  const runtime = await getWorkspaceAgentRuntime(agent, { events });
  const modelRef = context.model ? parseModelRef(context.model) : undefined;
  if (modelRef) await runtime.setModel(modelRef.provider, modelRef.id);
  const thinkingLevel = context.thinkingLevel || (modelRef ? await getModelThinkingLevel(modelRef.provider, modelRef.id) : undefined);
  if (thinkingLevel) await runtime.setThinkingLevel(thinkingLevel);
  if (context.serviceTier) await runtime.setServiceTier(context.serviceTier);

  if (context.initialPromptMode === "composer") {
    const prompt = context.initialPrompt ?? "";
    if (prompt) await stageInitialPrompt(workspaceId, agent.conversationId, prompt);
    const attachmentDraft = context.attachmentDraft ?? "";
    if (validDraftId(attachmentDraft)) await moveAttachmentDraft(attachmentDraft, agentAttachmentDraftId(workspaceId, agent.conversationId));
    return;
  }

  const prompt = await expandPromptTemplate(workspaceId, context.initialPrompt ?? "");
  const draftId = context.attachmentDraft ?? "";
  const { images, attachmentNotes } = validDraftId(draftId)
    ? await deliverAttachmentDraft(workspaceId, draftId)
    : { images: [], attachmentNotes: [] };
  if (!prompt.trim() && images.length === 0 && attachmentNotes.length === 0) return;

  await events.emit("workspace_user_activity", { workspaceId });
  maybeNameAgentFromPrompt(agent, [...runtime.userMessages(), prompt.trim()], { events, agentModel: runtime.currentModel() });
  await runtime.submit(prompt, { images, attachmentNotes });
  if (validDraftId(draftId)) await removeAttachmentDraft(draftId);
}
