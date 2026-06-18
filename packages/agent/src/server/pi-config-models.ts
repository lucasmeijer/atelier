import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

const fallbackAgentModels: ConfiguredAgentModel[] = [
  { provider: "openai-codex", id: "gpt-5.5", label: "GPT-5.5", active: true },
  { provider: "anthropic", id: "claude-opus-4-8", label: "Opus 4.8" },
  { provider: "fable", id: "fable", label: "Fable" },
];

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
  const selected: ConfiguredAgentModel[] = models.length > 0 ? models : fallbackAgentModels;
  const activeProvider = typeof active?.provider === "string" ? active.provider : selected.find((model) => model.active)?.provider ?? selected[0]?.provider;
  const activeId = typeof active?.id === "string" ? active.id : selected.find((model) => model.active)?.id ?? selected[0]?.id;
  return selected.map((model, index) => ({ ...model, active: activeProvider && activeId ? model.provider === activeProvider && model.id === activeId : index === 0 }));
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

export async function fakeConnectModelProvider(provider: string, method: "api_key" | "oauth" = "api_key"): Promise<void> {
  const auth = await createPiAuthStorage();
  auth.set(provider, method === "oauth"
    ? { type: "oauth", access: `atelier-fake-oauth-${provider}`, refresh: `atelier-fake-refresh-${provider}`, expires: Date.now() + 86_400_000 }
    : { type: "api_key", key: `atelier-fake-api-key-${provider}` });
}

export async function disconnectModelProvider(provider: string): Promise<void> {
  const auth = await createPiAuthStorage();
  auth.remove(provider);
}
