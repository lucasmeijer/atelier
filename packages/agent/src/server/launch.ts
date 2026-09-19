import { reconcileAgentModelPreferences, setActiveAgentModel } from "./model-preferences.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { invalidArguments, type JsonObject } from "@atelier/core";
import { hasAvailableConfiguredModel, renderModelSetupDialog, parseModelRef, modelRefValue } from "@atelier/llm/server";
import { turboStream, turboStreamResponse, type AgentWorkspaceParameters, type WorkspaceAgentLaunch } from "@atelier/shared";
import { listStagedAttachments } from "@atelier/prompt/server";
import { resolveNewWorkspaceAgentModel } from "./model-state.ts";
import { renderLaunchComposerSettings } from "./render-composer.ts";
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
  prepare: prepareAgentLaunch,
  async submit(form) {
    const hasPrompt = String(form.get("text") ?? "").trim().length > 0
      || (await listStagedAttachments(String(form.get("attachmentDraft") ?? ""))).length > 0;
    if (hasPrompt && !await hasAvailableConfiguredModel()) return { response: turboStreamResponse(turboStream("update", "settings_modal_host", await renderModelSetupDialog()), { status: 422 }) };
    const model = String(form.get("model") ?? "");
    const thinkingLevel = String(form.get("level") ?? "");
    return {
      async prepare() {
        const ref = parseModelRef(model);
        if (ref) await setActiveAgentModel(ref.provider, ref.id, thinkingLevel);
        const context = await prepareAgentLaunch({ model, thinkingLevel });
        return context ?? { agent: {} };
      },
    };
  },
  async prepareWorkspace(workspaceId, context) {
    await ensureDefaultWorkspaceAgentConversation(workspaceId, { topic: context?.agent?.initialPrompt });
  },
  async refreshConfiguration(frameId) {
    await reconcileAgentModelPreferences();
    await refreshConfiguredAgentRuntimes();
    return turboStream("append", frameId, '<span hidden data-controller="launch-model-refresh"></span>');
  },
};
