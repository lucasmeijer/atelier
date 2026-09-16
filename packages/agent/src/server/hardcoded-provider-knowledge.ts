interface ProviderModelReference {
  id: string;
  label?: string;
}

interface ProviderKnowledge {
  apiKeyExample?: string;
}

interface ProviderKnowledgeRegistry {
  readonly [provider: string]: ProviderKnowledge;
}

const hardcodedPopularModels: readonly (ProviderModelReference & { provider: string })[] = [
  { provider: "openai-codex", id: "gpt-6-astra" },
  { provider: "openai-codex", id: "gpt-5.6-terra" },
  { provider: "openai-codex", id: "gpt-5.6-luna" },
  { provider: "anthropic", id: "claude-fable-5" },
  { provider: "anthropic", id: "claude-opus-5" },
  { provider: "anthropic", id: "claude-opus-4-8" },
  { provider: "github-copilot", id: "gpt-6-astra" },
  { provider: "openai", id: "gpt-5.6-sol" },
  { provider: "xai", id: "grok-4.6" },
];

const hardcodedProviderKnowledge: ProviderKnowledgeRegistry = {
  openai: {
    apiKeyExample: "sk-proj-abc123def456...",
  },
  "openai-codex": {
    apiKeyExample: "sk-proj-abc123def456...",
  },
  anthropic: {
    apiKeyExample: "sk-ant-api03-abc123def456...",
  },
};

export function getProviderApiKeyExample(provider: string): string | undefined {
  return hardcodedProviderKnowledge[provider]?.apiKeyExample;
}

export function getPopularModelRank(provider: string, id: string): number | undefined {
  const rank = hardcodedPopularModels.findIndex((model) => model.provider === provider && model.id === id);
  return rank < 0 ? undefined : rank;
}

export function getPopularProviderRank(provider: string): number | undefined {
  if (provider === "openai") return undefined;
  const rank = hardcodedPopularModels.findIndex((model) => model.provider === provider);
  return rank < 0 ? undefined : rank;
}

/** Curated defaults first; otherwise one model with the highest known input price. */
export function defaultProviderModels<T extends { id: string; name?: string; cost?: { input?: number } }>(provider: string, models: readonly T[]): T[] {
  const curated = models.filter((model) => getPopularModelRank(provider, model.id) !== undefined)
    .sort((a, b) => getPopularModelRank(provider, a.id)! - getPopularModelRank(provider, b.id)!);
  if (curated.length) return curated;
  const priced = models.filter((model) => model.cost?.input !== undefined && Number.isFinite(model.cost.input))
    .sort((a, b) => b.cost!.input! - a.cost!.input! || (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id));
  return priced.slice(0, 1);
}
