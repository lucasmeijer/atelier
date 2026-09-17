import { reconcileAgentModelPreferences, setActiveAgentModel } from "./model-preferences.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { invalidArguments, type JsonObject } from "@atelier/core";
import { hasAvailableConfiguredModel, renderModelSetupDialog, parseModelRef, modelRefValue } from "@atelier/llm/server";
import { escapeHtml, turboStream, turboStreamResponse, type AgentWorkspaceParameters, type WorkspaceAgentLaunch } from "@atelier/shared";
import { renderTranscriptionComposerControl, transcriptionComposerController } from "@atelier/transcription/server";
import { resolveNewWorkspaceAgentModel } from "./model-state.ts";
import { renderLaunchComposerSettings, renderPromptActions, renderComposerActions } from "./render-composer.ts";
import { ids } from "./render-context.ts";
import { ensureDefaultWorkspaceAgentConversation } from "./session-store.ts";
import { refreshConfiguredAgentRuntimes } from "./runtime.ts";

const stringSchema = Type.String();

function stringParameter(parameters: JsonObject, name: string): string {
  const value = parameters[name];
  if (value === undefined || value === null) return "";
  if (!Value.Check(stringSchema, value)) throw invalidArguments(`agent.${name} must be a string`);
  return value.trim();
}

export async function prepareAgentLaunch(parameters: JsonObject = {}): Promise<{ agent: AgentWorkspaceParameters } | undefined> {
  const serviceTier = stringParameter(parameters, "serviceTier");
  const initialPromptMode = stringParameter(parameters, "initialPromptMode");
  if (initialPromptMode && initialPromptMode !== "composer") throw invalidArguments("agent.initialPromptMode must be composer");
  const agent: AgentWorkspaceParameters = {
    initialPrompt: stringParameter(parameters, "initialPrompt"),
    model: stringParameter(parameters, "model"),
    thinkingLevel: stringParameter(parameters, "thinkingLevel"),
    attachmentDraft: stringParameter(parameters, "attachmentDraft"),
  };
  if (initialPromptMode) agent.initialPromptMode = "composer";
  if (serviceTier) agent.serviceTier = serviceTier === "priority" ? "priority" : "default";
  if (!Object.values(agent).some(Boolean)) return undefined;
  if (!agent.initialPromptMode && (agent.initialPrompt || agent.attachmentDraft)) {
    const model = await resolveNewWorkspaceAgentModel(agent.model);
    if (!model) {
      agent.initialPromptMode = "composer";
      agent.model = "";
      agent.thinkingLevel = "";
      delete agent.serviceTier;
    } else if (agent.model) agent.model = modelRefValue(model);
  }
  return { agent };
}

export const nativeAgentLaunch: WorkspaceAgentLaunch = {
  renderFooter({ query, ...context }) {
    return renderLaunchComposerSettings({ ...context, selectedModel: query.get("model") ?? undefined, selectedThinkingLevel: query.get("level") ?? undefined });
  },
  async render(context) {
    const draftId = context.draftId;
    const rowId = ids.draftAttachRow(draftId);
    const uploadUrl = `/agent-attachment-drafts/${encodeURIComponent(draftId)}/attachments?row=${encodeURIComponent(rowId)}`;
    return {
      attributesHtml: `data-controller="composer-focus agent-model-setup agent-attachments ${transcriptionComposerController}" data-action="mousedown->composer-focus#preserveInputFocus dragover->agent-attachments#dragOver dragleave->agent-attachments#dragLeave drop->agent-attachments#drop" data-agent-attachments-upload-url-value="${escapeHtml(uploadUrl)}"`,
      formAttributesHtml: 'data-action="submit->agent-model-setup#guard submit->transcription-composer#submit keydown->submit-shortcut#keydown submit->submit-shortcut#submit submit->launch-composer-dialog#submit turbo:submit-end->submit-shortcut#submitted"',
      bodyHtml: `<input type="hidden" name="attachmentDraft" value="${escapeHtml(draftId)}">
        <div class="agent-attach-row" id="${rowId}" data-agent-attachments-target="row"></div>
        <div class="composer-input-area"><textarea class="composer-input" name="text" rows="8" enterkeyhint="send" placeholder="Describe what you want the agent to do… (optional)" aria-label="Describe what you want the agent to do… (optional)" data-action="paste->agent-attachments#paste"></textarea>${renderTranscriptionComposerControl()}</div>${renderComposerActions(renderPromptActions(undefined, false))}`,
      footerHtml: await nativeAgentLaunch.renderFooter(context),
      discardUrl: `/agent-attachment-drafts/${encodeURIComponent(draftId)}/discard`,
    };
  },
  prepare: prepareAgentLaunch,
  async submit(form) {
    if (!await hasAvailableConfiguredModel()) return { response: turboStreamResponse(turboStream("update", "settings_modal_host", await renderModelSetupDialog())) };
    const attachmentDraft = String(form.get("attachmentDraft") ?? "");
    if (!attachmentDraft) throw invalidArguments("attachmentDraft is required");
    const model = String(form.get("model") ?? "");
    const thinkingLevel = String(form.get("level") ?? "");
    return {
      submissionId: attachmentDraft,
      async prepare() {
        const ref = parseModelRef(model);
        if (ref) await setActiveAgentModel(ref.provider, ref.id, thinkingLevel);
        const context = await prepareAgentLaunch({ initialPrompt: String(form.get("text") ?? ""), model, thinkingLevel, attachmentDraft });
        return context!;
      },
    };
  },
  async prepareWorkspace(workspaceId, context) {
    await ensureDefaultWorkspaceAgentConversation(workspaceId, { topic: context?.agent?.initialPrompt, projectOnboarding: context?.projectOnboarding });
  },
  async refreshConfiguration(frameId) {
    await reconcileAgentModelPreferences();
    await refreshConfiguredAgentRuntimes();
    return turboStream("append", frameId, '<span hidden data-controller="launch-model-refresh"></span>');
  },
};
