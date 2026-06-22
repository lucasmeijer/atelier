import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { piConfigSeedDir } from "./pi-config-seed.ts";

/**
 * The configured list of models offered in the agent model picker.
 *
 * Stored in ATELIER_DATA_DIR/pi-config/models.json alongside pi's own model
 * configuration. Atelier owns this file; custom model/provider definitions stay
 * under `providers`, while the prompt picker state is top-level settings.
 */
export interface ConfiguredAgentModel {
  provider: string;
  id: string;
  label: string;
  active?: boolean;
}

interface ModelPreference {
  thinkingLevel?: string;
}

interface AgentModelsSettings {
  providers?: Record<string, unknown>;
  picker?: Array<{ provider?: unknown; id?: unknown; label?: unknown }>;
  activeModel?: { provider?: unknown; id?: unknown };
  modelPreferences?: Record<string, ModelPreference>;
}

export async function piModelsJsonPath(): Promise<string> {
  return join(await piConfigSeedDir(), "models.json");
}

async function piAuthJsonPath(): Promise<string> {
  return join(await piConfigSeedDir(), "auth.json");
}

async function getAgentModelsSettings(path?: string): Promise<AgentModelsSettings> {
  path ??= await piModelsJsonPath();
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
  const path = await piModelsJsonPath();
  const normalized = { providers: config.providers ?? {}, ...config };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`);
  await rename(tmp, path);
}

function modelSettingsKey(provider: string, id: string): string {
  return `${provider}::${id}`;
}

function configuredFromJson(config: AgentModelsSettings | undefined): ConfiguredAgentModel[] {
  const picker = config?.picker;
  const active = config?.activeModel;
  const models = Array.isArray(picker)
    ? picker.flatMap((entry) => {
      const provider = typeof entry.provider === "string" ? entry.provider : "";
      const id = typeof entry.id === "string" ? entry.id : "";
      if (!provider || !id) return [];
      return [{ provider, id, label: typeof entry.label === "string" && entry.label.trim() ? entry.label : id }];
    })
    : [];
  const activeProvider = typeof active?.provider === "string" ? active.provider : models[0]?.provider;
  const activeId = typeof active?.id === "string" ? active.id : models[0]?.id;
  return models.map((model, index) => ({ ...model, active: activeProvider && activeId ? model.provider === activeProvider && model.id === activeId : index === 0 }));
}

export async function getConfiguredAgentModels(): Promise<ConfiguredAgentModel[]> {
  return configuredFromJson(await getAgentModelsSettings());
}

export async function hasAvailableConfiguredAgentModel(): Promise<boolean> {
  const registry = await createPiModelRegistry();
  const available = new Set((registry.getAvailable() as Array<{ provider: string; id: string }>).map((model) => modelSettingsKey(model.provider, model.id)));
  return (await getConfiguredAgentModels()).some((model) => available.has(modelSettingsKey(model.provider, model.id)));
}

export async function setActiveAgentModel(provider: string, id: string): Promise<void> {
  const config = await getAgentModelsSettings();
  const current = configuredFromJson(config);
  const existing = current.find((model) => model.provider === provider && model.id === id);
  config.picker = current.map((model) => ({ provider: model.provider, id: model.id, label: model.label }));
  config.activeModel = { provider, id };
  if (!existing) config.picker.unshift({ provider, id, label: id });
  await setAgentModelsSettings(config);
}

export async function setPickerAgentModels(models: ConfiguredAgentModel[], active?: { provider: string; id: string }): Promise<void> {
  const config = await getAgentModelsSettings();
  const first = models[0];
  config.picker = models.map((model) => ({ provider: model.provider, id: model.id, label: model.label }));
  config.activeModel = active ?? models.find((model) => model.active) ?? (first ? { provider: first.provider, id: first.id } : undefined);
  await setAgentModelsSettings(config);
}

export async function getModelThinkingLevel(provider: string, id: string): Promise<string | undefined> {
  const config = await getAgentModelsSettings();
  const level = config.modelPreferences?.[modelSettingsKey(provider, id)]?.thinkingLevel;
  return typeof level === "string" && level ? level : undefined;
}

export async function setModelThinkingLevel(provider: string, id: string, thinkingLevel: string): Promise<void> {
  const config = await getAgentModelsSettings();
  config.modelPreferences = { ...(config.modelPreferences ?? {}) };
  config.modelPreferences[modelSettingsKey(provider, id)] = {
    ...(config.modelPreferences[modelSettingsKey(provider, id)] ?? {}),
    thinkingLevel,
  };
  await setAgentModelsSettings(config);
}

export async function createPiAuthStorage(): Promise<AuthStorage> {
  return AuthStorage.create(await piAuthJsonPath());
}

export async function createPiModelRegistry(): Promise<ModelRegistry> {
  const authStorage = await createPiAuthStorage();
  return ModelRegistry.create(authStorage, await piModelsJsonPath());
}

async function validateModelProviderApiKey(provider: string, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is required");

  const auth = AuthStorage.inMemory({ [provider]: { type: "api_key", key: trimmed } });
  const registry = ModelRegistry.create(auth, await piModelsJsonPath());
  const models = registry.getAll().filter((model) => model.provider === provider);
  const model = models[Math.floor(Math.random() * models.length)];
  if (!model) throw new Error(`No models found for provider "${provider}"`);

  const requestAuth = await registry.getApiKeyAndHeaders(model);
  if (!requestAuth.ok) throw new Error(requestAuth.error);

  const response = await completeSimple(model, {
    messages: [{ role: "user", content: "Reply with exactly: ok", timestamp: Date.now() }],
  }, {
    apiKey: requestAuth.apiKey,
    headers: requestAuth.headers,
    env: requestAuth.env,
    maxTokens: 1,
  });
  if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Provider rejected the API key");
}

export async function connectModelProviderApiKey(provider: string, key: string, options: { validate?: boolean } = {}): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is required");
  if (options.validate !== false) await validateModelProviderApiKey(provider, trimmed);
  const auth = await createPiAuthStorage();
  auth.set(provider, { type: "api_key", key: trimmed });
}

export async function disconnectModelProvider(provider: string): Promise<void> {
  const auth = await createPiAuthStorage();
  auth.remove(provider);
}
