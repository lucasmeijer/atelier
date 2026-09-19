import { providerAvailability } from "./provider-availability.ts";
import type { ModelRef } from "./model-reference.ts";
import { readJsonSettings, updateJsonSettings } from "@atelier/core/json-settings";
import { syncSubscriptionClis } from "./subscription-cli.ts";
import { defaultProviderModels } from "./hardcoded-provider-knowledge.ts";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atelierDataPath, getAtelierRuntimeContext, isJsonObject, type JsonObject, type JsonValue } from "@atelier/core";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface ConfiguredModel extends ModelRef { label: string }
const stringSchema = Type.String();
interface ModelSettings { providers?: JsonObject; picker?: ConfiguredModel[] }

export interface CustomModelsSaveResult {
  skippedOfficialModels: ModelRef[];
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

function modelReferenceFromJsonObject(value: JsonObject): ModelRef | undefined {
  const provider = jsonString(value.provider);
  const id = jsonString(value.id);
  return provider && id ? { provider, id } : undefined;
}

function configuredModelFromJson(value: JsonValue | undefined): ConfiguredModel | undefined {
  if (!isJsonObject(value)) return undefined;
  const reference = modelReferenceFromJsonObject(value);
  if (!reference) return undefined;
  return { ...reference, label: jsonString(value.label)?.trim() || reference.id };
}

function parseModelSettings(stored: JsonObject): ModelSettings {
  return {
    providers: isJsonObject(stored.providers) ? stored.providers : undefined,
    picker: Array.isArray(stored.picker) ? stored.picker.flatMap((entry) => {
      const model = configuredModelFromJson(entry);
      return model ? [model] : [];
    }) : undefined,
  };
}

async function getModelSettings(): Promise<ModelSettings> {
  return parseModelSettings(await readJsonSettings(piModelsJsonPath()));
}

async function updateModelSettings(update: (settings: ModelSettings) => void): Promise<void> {
  await updateJsonSettings(piModelsJsonPath(), (stored) => {
    const settings = parseModelSettings(stored);
    update(settings);
    stored.providers = settings.providers ?? {};
    if (settings.picker) stored.picker = settings.picker.map((model) => ({ ...model }));
  });
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

function withoutOfficialModelDuplicates(providers: JsonObject, officialRuntime: ModelRuntime): CustomModelsSaveResult & { providers: JsonObject } {
  const skippedOfficialModels: ModelRef[] = [];
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

async function materializeCustomModelProviders(providers: JsonObject): Promise<CustomModelsSaveResult> {
  const filtered = withoutOfficialModelDuplicates(providers, await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false }));
  await updateModelSettings((settings) => { settings.providers = filtered.providers; });
  return { skippedOfficialModels: filtered.skippedOfficialModels };
}

async function preparePiModelsJson(): Promise<void> {
  const settings = await getModelSettings();
  const stored = await readStoredCustomModelProviders();
  const providers = stored ?? settings.providers ?? {};
  if (!stored && Object.keys(providers).length) await writeJsonFile(piCustomModelsJsonPath(), { providers });
  await materializeCustomModelProviders(providers);
}

export async function getCustomModelsJson(): Promise<string> {
  const providers = await readStoredCustomModelProviders() ?? (await getModelSettings()).providers ?? {};
  return Object.keys(providers).length ? JSON.stringify({ providers }, null, 2) : "";
}

export async function setCustomModelsJson(source: string): Promise<CustomModelsSaveResult> {
  const providers = source.trim() ? parseCustomModelsJson(source) : {};
  await validateCustomModelProviders(providers);
  await writeJsonFile(piCustomModelsJsonPath(), { providers });
  const result = await materializeCustomModelProviders(providers);
  if (modelRuntime) await (await modelRuntime).refresh();
  return result;
}

export async function getConfiguredModels(): Promise<ConfiguredModel[]> { return (await getModelSettings()).picker ?? []; }
export function hasConnectedModelProvider(runtime: Pick<ModelRuntime, "getProviders" | "getProviderAuthStatus">): boolean {
  return runtime.getProviders().some((provider) => runtime.getProviderAuthStatus(provider.id).configured);
}

export async function hasAvailableConfiguredModel(): Promise<boolean> {
  const runtime = await createPiModelRuntime();
  const models = await getConfiguredModels();
  const availability = await providerAvailability(runtime, models.map((model) => model.provider));
  return models.some((model) => availability.get(model.provider)!.modelIds.has(model.id));
}

export async function setConfiguredModels(models: ConfiguredModel[]): Promise<void> {
  await updateModelSettings((settings) => { settings.picker = models.map(({ provider, id, label }) => ({ provider, id, label })); });
}

let modelRuntime: Promise<ModelRuntime> | undefined;
export function createPiModelRuntime(): Promise<ModelRuntime> {
  return modelRuntime ??= (async () => {
    await preparePiModelsJson();
    return await ModelRuntime.create({ authPath: piAuthJsonPath(), modelsPath: piModelsJsonPath() });
  })();
}

export type PiAuthPrompt = AuthPrompt;

export class ProviderCatalogueRefreshError extends Error {
  constructor(cause: unknown) {
    super(`Provider connected, but the online model catalogue refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "ProviderCatalogueRefreshError";
  }
}

async function refreshConnectedProviderCatalogue(runtime: ModelRuntime, provider: string, signal?: AbortSignal): Promise<void> {
  try {
    const result = await runtime.refresh({ providers: [provider], allowNetwork: true, force: true, signal });
    if (result.aborted) throw new Error("Catalogue refresh was interrupted.");
    const errors = [...result.errors.values()];
    if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
  } catch (error) {
    throw new ProviderCatalogueRefreshError(error);
  }
}

export async function loginPiOAuthProvider(providerId: string, interaction: AuthInteraction): Promise<void> {
  const runtime = await createPiModelRuntime();
  await runtime.login(providerId, "oauth", interaction);
  if (providerId === "openai-codex" || providerId === "anthropic") await syncSubscriptionClis(runtime);
  await refreshConnectedProviderCatalogue(runtime, providerId, interaction.signal);
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
  const runtime = await createPiModelRuntime();
  await runtime.login(provider, "api_key", {
    prompt: async (prompt) => prompt.type === "select" ? prompt.options[0]?.id ?? "" : trimmed,
    notify: () => {},
  });
  if (provider === "openai-codex" || provider === "anthropic") await syncSubscriptionClis(runtime);
  await refreshConnectedProviderCatalogue(runtime, provider);
}
export async function disconnectModelProvider(provider: string): Promise<void> {
  const runtime = await createPiModelRuntime();
  await runtime.logout(provider);
  if (provider === "openai-codex" || provider === "anthropic") await syncSubscriptionClis(runtime);
  await updateModelSettings((settings) => {
    settings.picker = (settings.picker ?? []).filter((model) => model.provider !== provider);
  });
}

export async function seedProviderFavoriteModels(provider: string): Promise<void> {
  const runtime = await createPiModelRuntime();
  const available = await runtime.getAvailable(provider);
  const defaults = defaultProviderModels(provider, available);
  await updateModelSettings((settings) => {
    const favorites = settings.picker ?? [];
    if (!favorites.some((model) => model.provider === provider)) {
      settings.picker = [...favorites, ...defaults.map((model) => ({ provider, id: model.id, label: model.name ?? model.id }))];
    }
  });
}
