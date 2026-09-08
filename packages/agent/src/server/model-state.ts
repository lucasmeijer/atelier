import type { AgentWorkspaceParameters } from "@atelier/shared";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createPiModelRuntime, getConfiguredAgentModels, getModelThinkingLevel, setActiveAgentModel } from "./pi-config-models.ts";

export interface ModelRef {
  provider: string;
  id: string;
}

export interface AgentModelOptionView {
  provider: string;
  id: string;
  name: string;
  selected: boolean;
  available: boolean;
  unavailableReason?: string;
}

export function parseModelRef(value: string): ModelRef | undefined {
  const separator = value.indexOf("::");
  if (separator <= 0 || separator === value.length - 2) return undefined;
  return { provider: value.slice(0, separator), id: value.slice(separator + 2) };
}

export function modelRefValue(ref: ModelRef): string {
  return `${ref.provider}::${ref.id}`;
}

export async function rememberNewWorkspaceAgentSettings(value: string, thinkingLevel?: string): Promise<void> {
  const ref = parseModelRef(value);
  if (!ref) return;
  await setActiveAgentModel(ref.provider, ref.id, thinkingLevel);
}

export function selectAvailableConfiguredModel(models: readonly AgentModelOptionView[], requested?: ModelRef): ModelRef | undefined {
  const selected = requested
    ? models.find((model) => model.available && model.provider === requested.provider && model.id === requested.id)
    : undefined;
  const fallback = selected ?? models.find((model) => model.available && model.selected) ?? models.find((model) => model.available);
  return fallback ? { provider: fallback.provider, id: fallback.id } : undefined;
}

export async function resolveNewWorkspaceAgentModel(selectedModel?: string): Promise<ModelRef | undefined> {
  const requested = selectedModel ? parseModelRef(selectedModel) : undefined;
  return selectAvailableConfiguredModel(await configuredModelOptionViews(), requested);
}

export async function prepareNewWorkspaceAgentParameters(agent: AgentWorkspaceParameters | undefined): Promise<AgentWorkspaceParameters | undefined> {
  if (!agent || agent.initialPromptMode || !(agent.initialPrompt?.trim() || agent.attachmentDraft)) return agent;
  const model = await resolveNewWorkspaceAgentModel(agent.model);
  if (!model) return { ...agent, initialPromptMode: "composer", model: undefined, thinkingLevel: undefined, serviceTier: undefined };
  return agent.model ? { ...agent, model: modelRefValue(model) } : agent;
}

/** Omit current to select the saved default; null represents a session without a model. */
export async function configuredModelOptionViews(current?: ModelRef | null, runtime?: Pick<Awaited<ReturnType<typeof createPiModelRuntime>>, "getAvailable" | "checkAuth" | "getModel">): Promise<AgentModelOptionView[]> {
  runtime ??= await createPiModelRuntime();
  const available = new Set((await runtime.getAvailable()).map(modelRefValue));
  const models = await getConfiguredAgentModels();
  const providers = [...new Set(models.map((model) => model.provider))];
  const auth = new Map(await Promise.all(providers.map(async (provider) =>
    [provider, await runtime.checkAuth(provider)] as const,
  )));
  return models.map((model) => {
    const isAvailable = available.has(modelRefValue(model));
    return {
      provider: model.provider,
      id: model.id,
      name: model.label,
      selected: current === undefined ? Boolean(model.active) : current !== null && current.provider === model.provider && current.id === model.id,
      available: isAvailable,
      unavailableReason: isAvailable ? undefined
        : !runtime.getModel(model.provider, model.id) ? "Model not found in provider catalog"
        : !auth.get(model.provider) ? "Provider not connected"
        : "Model unavailable for this account",
    };
  });
}

export async function launchComposerThinkingLevel(model: ModelRef | undefined): Promise<string | undefined> {
  return model ? await getModelThinkingLevel(model.provider, model.id) : undefined;
}

export async function launchComposerThinkingLevels(model: ModelRef | undefined): Promise<string[]> {
  if (!model) return [];
  const runtime = await createPiModelRuntime();
  const piModel = runtime.getModel(model.provider, model.id);
  return piModel ? getSupportedThinkingLevels(piModel) : [];
}
