import { readJsonSettings, updateJsonSettings } from "@atelier/core/json-settings";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { atelierDataPath, getAtelierRuntimeContext, isJsonObject, type JsonObject, type JsonValue } from "@atelier/core";
import type { AgentServiceTier } from "@atelier/shared";
import { getConfiguredModels, modelRefValue, type ModelRef } from "@atelier/llm/server";

// Retain the historical file and keys. Atomic updates preserve the LLM-owned catalogue.
function settingsPath(): string { return atelierDataPath(getAtelierRuntimeContext(), "pi-config", "models.json"); }
const stringSchema = Type.String();

function storedObject(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

function setThinkingPreference(settings: JsonObject, model: ModelRef, thinkingLevel: string): void {
  const preferences = storedObject(settings.modelPreferences);
  const key = modelRefValue(model);
  preferences[key] = { ...storedObject(preferences[key]), thinkingLevel };
  settings.modelPreferences = preferences;
}

export async function getConfiguredAgentModels() {
  const [models, stored] = await Promise.all([getConfiguredModels(), readJsonSettings(settingsPath())]);
  const active = storedObject(stored.activeModel);
  const selected = models.find((model) => model.provider === active.provider && model.id === active.id) ?? models[0];
  return models.map((model) => ({ ...model, active: model === selected }));
}

export async function setActiveAgentModel(provider: string, id: string, thinkingLevel?: string): Promise<void> {
  await updateJsonSettings(settingsPath(), (stored) => {
    const picker = Array.isArray(stored.picker) ? stored.picker : [];
    if (!picker.some((model) => isJsonObject(model) && model.provider === provider && model.id === id)) picker.unshift({ provider, id, label: id });
    stored.picker = picker;
    stored.activeModel = { provider, id };
    if (thinkingLevel) setThinkingPreference(stored, { provider, id }, thinkingLevel);
  });
}

export async function getModelThinkingLevel(provider: string, id: string): Promise<string | undefined> {
  const stored = await readJsonSettings(settingsPath());
  const preference = storedObject(storedObject(stored.modelPreferences)[modelRefValue({ provider, id })]);
  return Value.Check(stringSchema, preference.thinkingLevel) ? preference.thinkingLevel || undefined : undefined;
}

export async function setModelThinkingLevel(provider: string, id: string, thinkingLevel: string): Promise<void> {
  await updateJsonSettings(settingsPath(), (stored) => setThinkingPreference(stored, { provider, id }, thinkingLevel));
}

export async function getLastProviderServiceTier(provider: string): Promise<AgentServiceTier | undefined> {
  const stored = await readJsonSettings(settingsPath());
  const preference = storedObject(stored.providerPreferences)[provider];
  return isJsonObject(preference) ? preference.serviceTier === "priority" ? "priority" : "default" : undefined;
}

export async function setLastProviderServiceTier(provider: string, serviceTier: AgentServiceTier): Promise<void> {
  await updateJsonSettings(settingsPath(), (stored) => {
    const preferences = storedObject(stored.providerPreferences);
    if (storedObject(preferences[provider]).serviceTier === serviceTier) return false;
    preferences[provider] = { ...storedObject(preferences[provider]), serviceTier };
    stored.providerPreferences = preferences;
  });
}

export async function reconcileAgentModelPreferences(): Promise<void> {
  const models = await getConfiguredModels();
  await updateJsonSettings(settingsPath(), (stored) => {
    const active = storedObject(stored.activeModel);
    if (models.some((model) => model.provider === active.provider && model.id === active.id)) return false;
    const first = models[0];
    if (first) stored.activeModel = { provider: first.provider, id: first.id };
    else delete stored.activeModel;
  });
}
