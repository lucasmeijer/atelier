import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createPiModelRegistry, getConfiguredAgentModels, getModelThinkingLevel, setActiveAgentModel, setModelThinkingLevel, type ConfiguredAgentModel } from "./pi-config-models.ts";

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

export async function rememberPreferredAgentModel(value: string, thinkingLevel?: string): Promise<void> {
  const ref = parseModelRef(value);
  if (!ref) return;
  await setActiveAgentModel(ref.provider, ref.id);
  if (thinkingLevel) await setModelThinkingLevel(ref.provider, ref.id, thinkingLevel);
}

export async function preferredAgentModel(): Promise<ModelRef | undefined> {
  const configuredModels = await getConfiguredAgentModels();
  const active = configuredModels.find((model) => model.active) ?? configuredModels[0];
  return active ? { provider: active.provider, id: active.id } : undefined;
}

export async function selectedComposerModel(selectedModel?: string): Promise<ModelRef | undefined> {
  const configuredModels = await getConfiguredAgentModels();
  const selected = selectedModel ? parseModelRef(selectedModel) : undefined;
  if (selected && configuredModels.some((model) => model.provider === selected.provider && model.id === selected.id)) return selected;
  return await preferredAgentModel();
}

export async function configuredModelOptionViews(current?: ModelRef): Promise<AgentModelOptionView[]> {
  const registry = await createPiModelRegistry();
  const available = new Set((registry.getAvailable() as Array<{ provider: string; id: string }>).map((model) => `${model.provider}::${model.id}`));
  return (await getConfiguredAgentModels()).map((model) => modelOptionView(model, available, current));
}

function modelOptionView(model: ConfiguredAgentModel, available: Set<string>, current?: ModelRef): AgentModelOptionView {
  const key = `${model.provider}::${model.id}`;
  const isAvailable = available.has(key);
  return {
    provider: model.provider,
    id: model.id,
    name: model.label,
    selected: current ? current.provider === model.provider && current.id === model.id : Boolean(model.active),
    available: isAvailable,
    unavailableReason: isAvailable ? undefined : "Provider disconnected",
  };
}

export async function composerThinkingLevel(model: ModelRef | undefined): Promise<string | undefined> {
  return model ? await getModelThinkingLevel(model.provider, model.id) : undefined;
}

export async function composerThinkingLevels(model: ModelRef | undefined): Promise<string[]> {
  if (!model) return [];
  const registry = await createPiModelRegistry();
  const piModel = registry.find(model.provider, model.id);
  return piModel ? getSupportedThinkingLevels(piModel) : [];
}
