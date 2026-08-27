interface ProviderModelReference {
  id: string;
  label?: string;
}

interface ProviderKnowledge {
  apiKeyExample?: string;
  fastModel?: ProviderModelReference;
}

interface ProviderKnowledgeRegistry {
  readonly [provider: string]: ProviderKnowledge;
}

const hardcodedProviderKnowledge: ProviderKnowledgeRegistry = {
  openai: {
    apiKeyExample: "sk-proj-abc123def456...",
    fastModel: { id: "gpt-5.4-mini" },
  },
  "openai-codex": {
    apiKeyExample: "sk-proj-abc123def456...",
    fastModel: { id: "gpt-5.4-mini" },
  },
  anthropic: {
    apiKeyExample: "sk-ant-api03-abc123def456...",
    fastModel: { id: "claude-haiku-4-5" },
  },
};

export function getProviderApiKeyExample(provider: string): string | undefined {
  return hardcodedProviderKnowledge[provider]?.apiKeyExample;
}

export function getProviderFastModel(provider: string): ProviderModelReference | undefined {
  return hardcodedProviderKnowledge[provider]?.fastModel;
}
