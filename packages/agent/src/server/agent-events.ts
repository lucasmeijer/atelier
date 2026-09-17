import type { AtelierEventBus } from "@atelier/core";
import type { AgentWorkspaceParameters } from "@atelier/shared";
import { agentAttachmentDraftId, moveAttachmentDraft, validDraftId } from "@atelier/prompt/server";
import { stageInitialPrompt } from "./initial-prompt-draft.ts";
import { parseModelRef } from "@atelier/llm/server";
import { getModelThinkingLevel } from "./model-preferences.ts";
import { expandPromptTemplate } from "./prompt-templates.ts";
import { getWorkspaceAgentRuntime, removeWorkspaceAgentRuntimes } from "./runtime.ts";
import { resumeInterruptedAgentSessions } from "./restart-recovery.ts";
import { ensureDefaultWorkspaceAgentConversation } from "./session-store.ts";

export function registerAgentEvents(events: AtelierEventBus): void {
  events.on("workspace_deleting", ({ workspaceId }) => removeWorkspaceAgentRuntimes(workspaceId));
  events.on("atelier_host_started", ({ workspaces }) => {
    void resumeInterruptedAgentSessions(workspaces, events).catch((error) => {
      console.error("Could not inspect interrupted Agent sessions after Atelier restarted", error);
    });
  });
  events.on("workspace_created", async ({ workspaceId, context }) => {
    const agentContext = context?.agent;
    if (!agentContext || (agentContext.provider && agentContext.provider !== "builtin")) return;
    const hasPrompt = !agentContext.initialPromptMode && Boolean(agentContext.initialPrompt?.trim());
    if (hasPrompt) await events.emit("workspace_provision_progress", { workspaceId, detail: "Start initial agent task" });
    await initializeWorkspaceAgent(workspaceId, agentContext, events);
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

  const input = context.input!;
  if (context.initialPromptMode === "composer") {
    const prompt = input.text;
    if (prompt) await stageInitialPrompt(workspaceId, agent.conversationId, prompt);
    const attachmentDraft = context.attachmentDraft ?? "";
    if (validDraftId(attachmentDraft)) await moveAttachmentDraft(attachmentDraft, agentAttachmentDraftId(workspaceId, agent.conversationId));
    return;
  }

  const prompt = await expandPromptTemplate(workspaceId, input.text);
  const { images, attachmentNotes } = input;
  if (!prompt.trim() && images.length === 0 && attachmentNotes.length === 0) return;

  await events.emit("workspace_user_activity", { workspaceId });
  await runtime.submit(prompt, { images, attachmentNotes });
}
