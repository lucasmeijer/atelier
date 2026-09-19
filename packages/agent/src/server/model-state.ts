import { getConfiguredAgentModels, getModelThinkingLevel } from "./model-preferences.ts";
import { createPiModelRuntime, providerAvailability, modelThinkingLevels, parseModelRef, type ModelRef } from "@atelier/llm/server";

export interface AgentModelOptionView {
  provider: string;
  id: string;
  name: string;
  selected: boolean;
  available: boolean;
  unavailableReason?: string;
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

/** Omit current to select the saved default; null represents a session without a model. */
export async function configuredModelOptionViews(current?: ModelRef | null, runtime?: Pick<Awaited<ReturnType<typeof createPiModelRuntime>>, "getAvailable" | "checkAuth" | "getModel">): Promise<AgentModelOptionView[]> {
  runtime ??= await createPiModelRuntime();
  const models = await getConfiguredAgentModels();
  const availability = await providerAvailability(runtime, models.map((model) => model.provider));
  return models.map((model) => {
    const { modelIds, connection } = availability.get(model.provider)!;
    const isAvailable = modelIds.has(model.id);
    return {
      provider: model.provider,
      id: model.id,
      name: model.label,
      selected: current === undefined ? Boolean(model.active) : current !== null && current.provider === model.provider && current.id === model.id,
      available: isAvailable,
      unavailableReason: isAvailable ? undefined
        : connection === "needs_attention" ? "Reconnect in Settings → Models"
        : !runtime.getModel(model.provider, model.id) ? "Model not found in provider catalog"
        : connection === "disconnected" ? "Provider not connected"
        : "Model unavailable for this account",
    };
  });
}

export async function launchComposerThinkingSettings(model: ModelRef | undefined): Promise<{ levels: string[]; selected?: string }> {
  if (!model) return { levels: [] };
  const levels: string[] = await modelThinkingLevels(model);
  const remembered = await getModelThinkingLevel(model.provider, model.id);
  return { levels, selected: remembered && levels.includes(remembered) ? remembered : levels.includes("medium") ? "medium" : levels[0] };
}
