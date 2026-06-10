/**
 * The configured list of models offered in the agent model picker.
 * Hardcoded for now; later this can move into a config file
 * (e.g. the seeded models.json / settings.json).
 */
export interface ConfiguredAgentModel {
  provider: string;
  id: string;
  label: string;
}

export const configuredAgentModels: ConfiguredAgentModel[] = [
  { provider: "openai-codex", id: "gpt-5.5", label: "GPT-5.5" },
  { provider: "anthropic", id: "claude-opus-4-8", label: "Opus 4.8" },
  { provider: "fable", id: "fable", label: "Fable" },
];
