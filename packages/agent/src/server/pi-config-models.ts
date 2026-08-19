import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atelierDataPath, getAtelierRuntimeContext, isJsonObject, type JsonObject, type JsonValue } from "@atelier/core";
import type { AgentServiceTier } from "@atelier/shared";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** The configured list of models offered in the agent model picker. */
interface ModelReference { provider: string; id: string }
interface ModelPickerEntry extends ModelReference { label: string }
export interface ConfiguredAgentModel extends ModelPickerEntry {
  active?: boolean;
}

interface ModelPreference { thinkingLevel?: string }
interface ProviderPreference { serviceTier?: AgentServiceTier }
const modelPreferenceSchema = Type.Object({ thinkingLevel: Type.Optional(Type.String()) });
const stringSchema = Type.String();
interface AgentModelsSettings {
  providers?: JsonObject;
  picker?: ModelPickerEntry[];
  activeModel?: ModelReference;
  modelPreferences?: Record<string, ModelPreference>;
  providerPreferences?: Record<string, ProviderPreference>;
}

function piConfigDir(): string { return atelierDataPath(getAtelierRuntimeContext(), "pi-config"); }
function piModelsJsonPath(): string { return join(piConfigDir(), "models.json"); }
function piAuthJsonPath(): string { return join(piConfigDir(), "auth.json"); }

function jsonString(value: JsonValue | undefined): string | undefined {
  return Value.Check(stringSchema, value) ? value : undefined;
}

function modelReferenceFromJsonObject(value: JsonObject): ModelReference | undefined {
  const provider = jsonString(value.provider);
  const id = jsonString(value.id);
  return provider && id ? { provider, id } : undefined;
}

function configuredModelFromJson(value: JsonValue | undefined): ModelPickerEntry | undefined {
  if (!isJsonObject(value)) return undefined;
  const reference = modelReferenceFromJsonObject(value);
  if (!reference) return undefined;
  return { ...reference, label: jsonString(value.label)?.trim() || reference.id };
}

async function getAgentModelsSettings(path = piModelsJsonPath()): Promise<AgentModelsSettings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isJsonObject(parsed)) throw new Error(`${path} must contain a JSON object`);
    const picker = Array.isArray(parsed.picker)
      ? parsed.picker.flatMap((entry) => {
        const model = configuredModelFromJson(entry);
        return model ? [model] : [];
      })
      : undefined;
    const activeModel = isJsonObject(parsed.activeModel)
      ? modelReferenceFromJsonObject(parsed.activeModel)
      : undefined;
    const modelPreferences = isJsonObject(parsed.modelPreferences)
      ? Object.fromEntries(Object.entries(parsed.modelPreferences).flatMap(([key, preference]) => Value.Check(modelPreferenceSchema, preference)
        ? [[key, preference]]
        : []))
      : undefined;
    const providerPreferences = isJsonObject(parsed.providerPreferences)
      ? Object.fromEntries(Object.entries(parsed.providerPreferences).flatMap(([key, preference]) => isJsonObject(preference)
        ? [[key, { serviceTier: preference.serviceTier === "priority" ? "priority" : "default" } satisfies ProviderPreference]]
        : []))
      : undefined;
    return {
      providers: isJsonObject(parsed.providers) ? parsed.providers : undefined,
      picker,
      activeModel,
      modelPreferences,
      providerPreferences,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { providers: {} };
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
function configuredFromSettings(config: AgentModelsSettings | undefined): ConfiguredAgentModel[] {
  const models = config?.picker ?? [];
  const active = config?.activeModel ?? models[0];
  return models.map((model) => ({
    ...model,
    active: model.provider === active?.provider && model.id === active.id,
  }));
}

export async function getConfiguredAgentModels(): Promise<ConfiguredAgentModel[]> { return configuredFromSettings(await getAgentModelsSettings()); }
export async function hasAvailableConfiguredAgentModel(): Promise<boolean> {
  const runtime = await createPiModelRuntime();
  const available = new Set((await runtime.getAvailable()).map((model) => modelSettingsKey(model.provider, model.id)));
  return (await getConfiguredAgentModels()).some((model) => available.has(modelSettingsKey(model.provider, model.id)));
}

export async function setActiveAgentModel(provider: string, id: string, thinkingLevel?: string): Promise<void> {
  const config = await getAgentModelsSettings();
  const current = configuredFromSettings(config);
  config.picker = current.map((model) => ({ provider: model.provider, id: model.id, label: model.label }));
  config.activeModel = { provider, id };
  if (!current.some((model) => model.provider === provider && model.id === id)) config.picker.unshift({ provider, id, label: id });
  if (thinkingLevel) {
    config.modelPreferences = { ...(config.modelPreferences ?? {}) };
    config.modelPreferences[modelSettingsKey(provider, id)] = { ...(config.modelPreferences[modelSettingsKey(provider, id)] ?? {}), thinkingLevel };
  }
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
  return level || undefined;
}
export async function setModelThinkingLevel(provider: string, id: string, thinkingLevel: string): Promise<void> {
  const config = await getAgentModelsSettings();
  config.modelPreferences = { ...(config.modelPreferences ?? {}) };
  config.modelPreferences[modelSettingsKey(provider, id)] = { ...(config.modelPreferences[modelSettingsKey(provider, id)] ?? {}), thinkingLevel };
  await setAgentModelsSettings(config);
}

export async function getLastProviderServiceTier(provider: string): Promise<AgentServiceTier | undefined> {
  return (await getAgentModelsSettings()).providerPreferences?.[provider]?.serviceTier;
}

export async function setLastProviderServiceTier(provider: string, serviceTier: AgentServiceTier): Promise<void> {
  const config = await getAgentModelsSettings();
  if (config.providerPreferences?.[provider]?.serviceTier === serviceTier) return;
  config.providerPreferences = { ...(config.providerPreferences ?? {}) };
  config.providerPreferences[provider] = { ...(config.providerPreferences[provider] ?? {}), serviceTier };
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
