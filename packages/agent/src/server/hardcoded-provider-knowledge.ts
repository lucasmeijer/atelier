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

/** Provider order follows its first appearance in the curated popular-model list. */
export function getPopularProviderRank(provider: string): number | undefined {
  const rank = hardcodedPopularModels.findIndex((model) => model.provider === provider);
  return rank < 0 ? undefined : rank;
}
