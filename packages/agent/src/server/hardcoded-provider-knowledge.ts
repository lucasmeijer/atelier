import { getConfiguredAgentModels, setPickerAgentModels, type ConfiguredAgentModel } from "./pi-config-models.ts";

export interface HardcodedProviderModel {
  id: string;
  label?: string;
}

export interface HardcodedProviderKnowledge {
  apiKeyExample?: string;
  models: readonly HardcodedProviderModel[];
  fastModel?: HardcodedProviderModel;
}

export const hardcodedProviderKnowledge: Readonly<Record<string, HardcodedProviderKnowledge>> = {
  openai: {
    apiKeyExample: "sk-proj-abc123def456...",
    models: [{ id: "gpt-5.6" }],
    fastModel: { id: "gpt-5.4-mini" },
  },
  "openai-codex": {
    apiKeyExample: "sk-proj-abc123def456...",
    models: [{ id: "gpt-5.6-sol" }],
    fastModel: { id: "gpt-5.4-mini" },
  },
  anthropic: {
    apiKeyExample: "sk-ant-api03-abc123def456...",
    models: [{ id: "claude-opus-4-8" }],
    fastModel: { id: "claude-haiku-4-5" },
  },
};

export function getProviderApiKeyExample(provider: string): string | undefined {
  return hardcodedProviderKnowledge[provider]?.apiKeyExample;
}

export function getProviderFastModel(provider: string): HardcodedProviderModel | undefined {
  return hardcodedProviderKnowledge[provider]?.fastModel;
}

function sameModel(a: { provider: string; id: string }, b: { provider: string; id: string }): boolean {
  return a.provider === b.provider && a.id === b.id;
}

export async function addHardcodedProviderModels(provider: string): Promise<void> {
  const models = hardcodedProviderKnowledge[provider]?.models;
  if (!models?.length) return;

  const current = await getConfiguredAgentModels();
  const next: ConfiguredAgentModel[] = [...current];
  for (const model of models) {
    const configuredModel = { provider, id: model.id, label: model.label ?? model.id };
    if (!next.some((candidate) => sameModel(candidate, configuredModel))) next.push(configuredModel);
  }
  if (next.length === current.length) return;

  const active = current.find((model) => model.active && next.some((candidate) => sameModel(candidate, model)));
  await setPickerAgentModels(next, active);
}
