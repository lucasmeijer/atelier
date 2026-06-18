import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { piConfigSeedDir } from "./pi-config-seed.ts";

/**
 * The configured list of models offered in the agent model picker.
 *
 * Stored in ATELIER_DATA_DIR/pi-config/models.json alongside pi's own model
 * configuration. The `atelier` key is Atelier metadata; pi's schema tolerates
 * extra top-level keys, while its real custom model configuration remains under
 * `providers`.
 */
export interface ConfiguredAgentModel {
  provider: string;
  id: string;
  label: string;
  active?: boolean;
}

interface AtelierModelsJson {
  providers?: Record<string, unknown>;
  atelier?: {
    picker?: Array<{ provider?: unknown; id?: unknown; label?: unknown }>;
    activeModel?: { provider?: unknown; id?: unknown };
  };
}

function syncPiConfigSeedDir(): string {
  // Mirrors piConfigSeedDir(), but remains synchronous so runtime constructors
  // can build model lists without async work.
  const dataDir = process.env.ATELIER_DATA_DIR
    ?? (process.platform === "darwin" ? join(process.env.HOME ?? ".", "Library", "Application Support", "atelier") : "/var/lib/atelier");
  return join(dataDir, "pi-config");
}

export function piModelsJsonPathSync(): string {
  return join(syncPiConfigSeedDir(), "models.json");
}

export async function piModelsJsonPath(): Promise<string> {
  return join(await piConfigSeedDir(), "models.json");
}

export async function piAuthJsonPath(): Promise<string> {
  return join(await piConfigSeedDir(), "auth.json");
}

function parseModelsJsonSync(path = piModelsJsonPathSync()): AtelierModelsJson | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as AtelierModelsJson : undefined;
  } catch {
    return undefined;
  }
}

async function loadModelsJson(path?: string): Promise<AtelierModelsJson> {
  path ??= await piModelsJsonPath();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as AtelierModelsJson : { providers: {} };
  } catch {
    return { providers: {} };
  }
}

async function saveModelsJson(config: AtelierModelsJson): Promise<void> {
  const path = await piModelsJsonPath();
  const normalized = { providers: config.providers ?? {}, ...config };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`);
  await rename(tmp, path);
}

function configuredFromJson(config: AtelierModelsJson | undefined): ConfiguredAgentModel[] {
  const picker = config?.atelier?.picker;
  const active = config?.atelier?.activeModel;
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

export function loadConfiguredAgentModelsSync(): ConfiguredAgentModel[] {
  return configuredFromJson(parseModelsJsonSync());
}

export const configuredAgentModels: ConfiguredAgentModel[] = loadConfiguredAgentModelsSync();

export async function setActiveAgentModel(provider: string, id: string): Promise<void> {
  const config = await loadModelsJson();
  const current = configuredFromJson(config);
  const existing = current.find((model) => model.provider === provider && model.id === id);
  config.atelier = {
    ...(config.atelier ?? {}),
    picker: current.map((model) => ({ provider: model.provider, id: model.id, label: model.label })),
    activeModel: { provider, id },
  };
  if (!existing) config.atelier.picker?.unshift({ provider, id, label: id });
  await saveModelsJson(config);
  configuredAgentModels.splice(0, configuredAgentModels.length, ...configuredFromJson(config));
}

export async function setPickerAgentModels(models: ConfiguredAgentModel[], active?: { provider: string; id: string }): Promise<void> {
  const config = await loadModelsJson();
  const first = models[0];
  config.atelier = {
    ...(config.atelier ?? {}),
    picker: models.map((model) => ({ provider: model.provider, id: model.id, label: model.label })),
    activeModel: active ?? models.find((model) => model.active) ?? (first ? { provider: first.provider, id: first.id } : undefined),
  };
  await saveModelsJson(config);
  configuredAgentModels.splice(0, configuredAgentModels.length, ...configuredFromJson(config));
}

export async function createPiAuthStorage(): Promise<AuthStorage> {
  return AuthStorage.create(await piAuthJsonPath());
}

export async function createPiModelRegistry(): Promise<ModelRegistry> {
  const authStorage = await createPiAuthStorage();
  return ModelRegistry.create(authStorage, await piModelsJsonPath());
}

export async function validateModelProviderApiKey(provider: string, key: string): Promise<void> {
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
