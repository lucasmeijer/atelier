import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atelierDataPath, getAtelierRuntimeContext } from "@atelier/core";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** The configured list of models offered in the agent model picker. */
export interface ConfiguredAgentModel {
  provider: string;
  id: string;
  label: string;
  active?: boolean;
}

interface ModelPreference { thinkingLevel?: string }
interface AgentModelsSettings {
  providers?: Record<string, unknown>;
  picker?: Array<{ provider?: unknown; id?: unknown; label?: unknown }>;
  activeModel?: { provider?: unknown; id?: unknown };
  modelPreferences?: Record<string, ModelPreference>;
}

function piConfigDir(): string { return atelierDataPath(getAtelierRuntimeContext(), "pi-config"); }
function piModelsJsonPath(): string { return join(piConfigDir(), "models.json"); }
function piAuthJsonPath(): string { return join(piConfigDir(), "auth.json"); }

async function getAgentModelsSettings(path = piModelsJsonPath()): Promise<AgentModelsSettings> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error(`${path} must contain a JSON object`);
    return parsed as AgentModelsSettings;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { providers: {} };
    throw error;
  }
}

async function setAgentModelsSettings(config: AgentModelsSettings): Promise<void> {
  const path = piModelsJsonPath();
  const normalized = { providers: config.providers ?? {}, ...config };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`);
  await rename(tmp, path);
}

function modelSettingsKey(provider: string, id: string): string { return `${provider}::${id}`; }
function configuredFromJson(config: AgentModelsSettings | undefined): ConfiguredAgentModel[] {
  const models = Array.isArray(config?.picker) ? config.picker.flatMap((entry) => {
    const provider = typeof entry.provider === "string" ? entry.provider : "";
    const id = typeof entry.id === "string" ? entry.id : "";
    return provider && id ? [{ provider, id, label: typeof entry.label === "string" && entry.label.trim() ? entry.label : id }] : [];
  }) : [];
  const activeProvider = typeof config?.activeModel?.provider === "string" ? config.activeModel.provider : models[0]?.provider;
  const activeId = typeof config?.activeModel?.id === "string" ? config.activeModel.id : models[0]?.id;
  return models.map((model, index) => ({ ...model, active: activeProvider && activeId ? model.provider === activeProvider && model.id === activeId : index === 0 }));
}

export async function getConfiguredAgentModels(): Promise<ConfiguredAgentModel[]> { return configuredFromJson(await getAgentModelsSettings()); }
export async function hasAvailableConfiguredAgentModel(): Promise<boolean> {
  const runtime = await createPiModelRuntime();
  const available = new Set((await runtime.getAvailable()).map((model) => modelSettingsKey(model.provider, model.id)));
  return (await getConfiguredAgentModels()).some((model) => available.has(modelSettingsKey(model.provider, model.id)));
}

export async function setActiveAgentModel(provider: string, id: string): Promise<void> {
  const config = await getAgentModelsSettings();
  const current = configuredFromJson(config);
  config.picker = current.map((model) => ({ provider: model.provider, id: model.id, label: model.label }));
  config.activeModel = { provider, id };
  if (!current.some((model) => model.provider === provider && model.id === id)) config.picker.unshift({ provider, id, label: id });
  await setAgentModelsSettings(config);
}

export async function setPickerAgentModels(models: ConfiguredAgentModel[], active?: { provider: string; id: string }): Promise<void> {
  const config = await getAgentModelsSettings();
  config.picker = models.map(({ provider, id, label }) => ({ provider, id, label }));
  const first = models[0];
  config.activeModel = active ?? models.find((model) => model.active) ?? (first ? { provider: first.provider, id: first.id } : undefined);
  await setAgentModelsSettings(config);
}

export async function getModelThinkingLevel(provider: string, id: string): Promise<string | undefined> {
  const level = (await getAgentModelsSettings()).modelPreferences?.[modelSettingsKey(provider, id)]?.thinkingLevel;
  return typeof level === "string" && level ? level : undefined;
}
export async function setModelThinkingLevel(provider: string, id: string, thinkingLevel: string): Promise<void> {
  const config = await getAgentModelsSettings();
  config.modelPreferences = { ...(config.modelPreferences ?? {}) };
  config.modelPreferences[modelSettingsKey(provider, id)] = { ...(config.modelPreferences[modelSettingsKey(provider, id)] ?? {}), thinkingLevel };
  await setAgentModelsSettings(config);
}

let modelRuntime: Promise<ModelRuntime> | undefined;
export function createPiModelRuntime(): Promise<ModelRuntime> {
  return modelRuntime ??= ModelRuntime.create({ authPath: piAuthJsonPath(), modelsPath: piModelsJsonPath() });
}

export type PiAuthPrompt = AuthPrompt;
type PiAuthInteraction = AuthInteraction;

export async function loginPiOAuthProvider(providerId: string, interaction: PiAuthInteraction): Promise<void> {
  await (await createPiModelRuntime()).login(providerId, "oauth", interaction);
}

async function validateModelProviderApiKey(provider: string, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is required");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(provider, async () => ({ type: "api_key", key: trimmed }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: piModelsJsonPath(), allowModelNetwork: false });
  const models = runtime.getModels(provider);
  const model = models[Math.floor(Math.random() * models.length)];
  if (!model) throw new Error(`No models found for provider "${provider}"`);
  const response = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Reply with exactly: ok", timestamp: Date.now() }] }, { maxTokens: 1 });
  if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Provider rejected the API key");
}

export async function connectModelProviderApiKey(provider: string, key: string, options: { validate?: boolean } = {}): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is required");
  if (options.validate !== false) await validateModelProviderApiKey(provider, trimmed);
  await (await createPiModelRuntime()).login(provider, "api_key", {
    prompt: async (prompt) => prompt.type === "select" ? prompt.options[0]?.id ?? "" : trimmed,
    notify: () => {},
  });
}
export async function disconnectModelProvider(provider: string): Promise<void> {
  await (await createPiModelRuntime()).logout(provider);
}
