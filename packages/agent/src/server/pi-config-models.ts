import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createKeyedOperationQueue, atelierDataPath, getAtelierRuntimeContext, isJsonObject, type JsonObject, type JsonValue } from "@atelier/core";
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

export interface CustomModelsSaveResult {
  skippedOfficialModels: ModelReference[];
}

function piConfigDir(): string { return atelierDataPath(getAtelierRuntimeContext(), "pi-config"); }
function piModelsJsonPath(): string { return join(piConfigDir(), "models.json"); }
function piCustomModelsJsonPath(): string { return join(piConfigDir(), "custom-models.json"); }
function piAuthJsonPath(): string { return join(piConfigDir(), "auth.json"); }

async function writeJsonFile(path: string, value: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

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

const serializeSettingsUpdate = createKeyedOperationQueue();

async function updateAgentModelsSettings(update: (config: AgentModelsSettings) => void | false): Promise<void> {
  const path = piModelsJsonPath();
  await serializeSettingsUpdate(path, async () => {
    const config = await getAgentModelsSettings(path);
    if (update(config) === false) return;
    await writeAgentModelsSettings(path, config);
  });
}

async function writeAgentModelsSettings(path: string, config: AgentModelsSettings): Promise<void> {
  const value: JsonObject = { providers: config.providers ?? {} };
  if (config.picker) value.picker = config.picker.map((model) => ({ provider: model.provider, id: model.id, label: model.label }));
  if (config.activeModel) value.activeModel = { provider: config.activeModel.provider, id: config.activeModel.id };
  if (config.modelPreferences) value.modelPreferences = Object.fromEntries(Object.entries(config.modelPreferences).map(([key, preference]) => [key, { ...preference }]));
  if (config.providerPreferences) value.providerPreferences = Object.fromEntries(Object.entries(config.providerPreferences).map(([key, preference]) => [key, { ...preference }]));
  await writeJsonFile(path, value);
}

function parseCustomModelsJson(source: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isJsonObject(parsed)) throw new Error("Custom model configuration must be a JSON object.");
  const unexpected = Object.keys(parsed).filter((key) => key !== "providers");
  if (unexpected.length) throw new Error(`Only the providers property is accepted here. Remove: ${unexpected.join(", ")}.`);
  if (!isJsonObject(parsed.providers)) throw new Error('Custom model configuration must contain a "providers" object.');
  return parsed.providers;
}

async function validateCustomModelProviders(providers: JsonObject): Promise<void> {
  const path = join(piConfigDir(), `.custom-models-validation-${crypto.randomUUID()}.json`);
  await writeJsonFile(path, { providers });
  try {
    const validationRuntime = await ModelRuntime.create({ modelsPath: path, allowModelNetwork: false, refreshOnCreate: false });
    const error = validationRuntime.getError();
    if (error) throw new Error(error.replace(`\n\nFile: ${path}`, ""));
  } finally {
    await unlink(path);
  }
}

async function readStoredCustomModelProviders(): Promise<JsonObject | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(piCustomModelsJsonPath(), "utf8"));
    if (!isJsonObject(parsed) || !isJsonObject(parsed.providers)) throw new Error(`${piCustomModelsJsonPath()} must contain a providers object`);
    return parsed.providers;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeStoredCustomModelProviders(providers: JsonObject): Promise<void> {
  await writeJsonFile(piCustomModelsJsonPath(), { providers });
}

function withoutOfficialModelDuplicates(providers: JsonObject, officialRuntime: ModelRuntime): CustomModelsSaveResult & { providers: JsonObject } {
  const skippedOfficialModels: ModelReference[] = [];
  const filtered = structuredClone(providers);
  for (const [providerId, value] of Object.entries(filtered)) {
    if (!isJsonObject(value) || !Array.isArray(value.models)) continue;
    const officialIds = new Set(officialRuntime.getModels(providerId).map((model) => model.id));
    value.models = value.models.filter((model) => {
      if (!isJsonObject(model)) return true;
      const id = jsonString(model.id);
      if (!id || !officialIds.has(id)) return true;
      skippedOfficialModels.push({ provider: providerId, id });
      return false;
    });
  }
  return { providers: filtered, skippedOfficialModels };
}

async function officialPiModelRuntime(): Promise<ModelRuntime> {
  return await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
}

async function materializeCustomModelProviders(providers: JsonObject): Promise<CustomModelsSaveResult> {
  const filtered = withoutOfficialModelDuplicates(providers, await officialPiModelRuntime());
  await updateAgentModelsSettings((settings) => { settings.providers = filtered.providers; });
  return { skippedOfficialModels: filtered.skippedOfficialModels };
}

async function preparePiModelsJson(): Promise<void> {
  const settings = await getAgentModelsSettings();
  const stored = await readStoredCustomModelProviders();
  const providers = stored ?? settings.providers ?? {};
  if (!stored && Object.keys(providers).length) await writeStoredCustomModelProviders(providers);
  await materializeCustomModelProviders(providers);
}

export async function getCustomModelsJson(): Promise<string> {
  const providers = await readStoredCustomModelProviders() ?? (await getAgentModelsSettings()).providers ?? {};
  return Object.keys(providers).length ? JSON.stringify({ providers }, null, 2) : "";
}

export async function setCustomModelsJson(source: string): Promise<CustomModelsSaveResult> {
  const providers = source.trim() ? parseCustomModelsJson(source) : {};
  await validateCustomModelProviders(providers);
  await writeStoredCustomModelProviders(providers);
  const result = await materializeCustomModelProviders(providers);
  if (modelRuntime) await (await modelRuntime).refresh();
  return result;
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
  await updateAgentModelsSettings((config) => {
    const current = configuredFromSettings(config);
    config.picker = current.map((model) => ({ provider: model.provider, id: model.id, label: model.label }));
    config.activeModel = { provider, id };
    if (!current.some((model) => model.provider === provider && model.id === id)) config.picker.unshift({ provider, id, label: id });
    if (thinkingLevel) {
      config.modelPreferences = { ...(config.modelPreferences ?? {}) };
      config.modelPreferences[modelSettingsKey(provider, id)] = { ...(config.modelPreferences[modelSettingsKey(provider, id)] ?? {}), thinkingLevel };
    }
  });
}

export async function setPickerAgentModels(models: ConfiguredAgentModel[], active?: { provider: string; id: string }): Promise<void> {
  await updateAgentModelsSettings((config) => {
    config.picker = models.map(({ provider, id, label }) => ({ provider, id, label }));
    const first = models[0];
    config.activeModel = active ?? models.find((model) => model.active) ?? (first ? { provider: first.provider, id: first.id } : undefined);
  });
}

export async function getModelThinkingLevel(provider: string, id: string): Promise<string | undefined> {
  const level = (await getAgentModelsSettings()).modelPreferences?.[modelSettingsKey(provider, id)]?.thinkingLevel;
  return level || undefined;
}
export async function setModelThinkingLevel(provider: string, id: string, thinkingLevel: string): Promise<void> {
  await updateAgentModelsSettings((config) => {
    config.modelPreferences = { ...(config.modelPreferences ?? {}) };
    config.modelPreferences[modelSettingsKey(provider, id)] = { ...(config.modelPreferences[modelSettingsKey(provider, id)] ?? {}), thinkingLevel };
  });
}

export async function getLastProviderServiceTier(provider: string): Promise<AgentServiceTier | undefined> {
  return (await getAgentModelsSettings()).providerPreferences?.[provider]?.serviceTier;
}

export async function setLastProviderServiceTier(provider: string, serviceTier: AgentServiceTier): Promise<void> {
  await updateAgentModelsSettings((config) => {
    if (config.providerPreferences?.[provider]?.serviceTier === serviceTier) return false;
    config.providerPreferences = { ...(config.providerPreferences ?? {}) };
    config.providerPreferences[provider] = { ...(config.providerPreferences[provider] ?? {}), serviceTier };
  });
}

let modelRuntime: Promise<ModelRuntime> | undefined;
export function createPiModelRuntime(): Promise<ModelRuntime> {
  return modelRuntime ??= (async () => {
    await preparePiModelsJson();
    return await ModelRuntime.create({ authPath: piAuthJsonPath(), modelsPath: piModelsJsonPath() });
  })();
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
