import { Type } from "typebox";
import { Value } from "typebox/value";
import { invalidArguments, type JsonObject } from "@atelier/core";
import { createPiModelRuntime, getConfiguredModels, modelRefValue, modelThinkingLevels, renderLaunchModelSettings, type ComposerModelOption } from "@atelier/llm/server";
import type { AgentLaunchFooterContext } from "@atelier/shared";

const settingsSchema = Type.Object({ model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(Type.String()) });

export interface CodexLaunchSettings { model?: string; thinkingLevel?: string }

async function choices(requestedModel?: string, requestedLevel?: string) {
  const runtime = await createPiModelRuntime();
  const available = new Set((await runtime.getAvailable()).map(modelRefValue));
  const favorites = (await getConfiguredModels()).filter((model) => model.provider === "openai-codex");
  const selected = favorites.find((model) => modelRefValue(model) === requestedModel && available.has(modelRefValue(model)))
    ?? favorites.find((model) => available.has(modelRefValue(model)));
  const selectedValue = selected ? modelRefValue(selected) : "";
  const models: ComposerModelOption[] = favorites.map((model) => ({
    ...model, name: model.label, selected: modelRefValue(model) === selectedValue,
    available: available.has(modelRefValue(model)),
    unavailableReason: available.has(modelRefValue(model)) ? undefined : "Model unavailable for this account",
  }));
  const selectedModel = selected ? runtime.getModel(selected.provider, selected.id) : undefined;
  // The CLI expects provider-native efforts, not Pi's abstract thinking levels.
  const thinkingLevels = selected && selectedModel ? [...new Set((await modelThinkingLevels(selected)).flatMap((level) => {
    const mapped = selectedModel.thinkingLevelMap?.[level];
    return mapped === null ? [] : [mapped ?? (level === "off" ? "none" : level)];
  }))] : [];
  const selectedThinkingLevel = requestedLevel && thinkingLevels.includes(requestedLevel) ? requestedLevel
    : thinkingLevels.includes("medium") ? "medium" : thinkingLevels[0] ?? "";
  return { models, selectedValue, thinkingLevels, selectedThinkingLevel, connectedProvider: runtime.getProviderAuthStatus("openai-codex").configured };
}

export async function renderCodexModelSettings(context: AgentLaunchFooterContext): Promise<string> {
  return renderLaunchModelSettings({ ...context, agentProvider: "codex", ...await choices(context.query.get("model") ?? undefined, context.query.get("level") ?? undefined) });
}

/** Only available Codex favorites and supported reasoning levels may reach the CLI. */
export async function prepareCodexModelSettings(parameters: JsonObject = {}): Promise<CodexLaunchSettings> {
  const settings = { model: parameters.model, thinkingLevel: parameters.thinkingLevel };
  if (!Value.Check(settingsSchema, settings)) throw invalidArguments("Codex model and thinkingLevel must be strings");
  const { model, thinkingLevel: level } = settings;
  const options = await choices(model, level);
  if (model && !options.models.some((item) => modelRefValue(item) === model && item.available)) throw invalidArguments("Choose an available favorite Codex model");
  if (level && !options.thinkingLevels.includes(level)) throw invalidArguments("Unsupported Codex thinking level");
  return { model: options.selectedValue || undefined, thinkingLevel: options.selectedThinkingLevel || undefined };
}
