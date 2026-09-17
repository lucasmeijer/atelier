import { Type } from "typebox";
import { Value } from "typebox/value";
import { invalidArguments, type JsonObject } from "@atelier/core";
import { createPiModelRuntime, getConfiguredModels, modelRefValue, modelThinkingLevels, renderLaunchModelSettings, type ComposerModelOption } from "@atelier/llm/server";
import type { AgentLaunchFooterContext } from "@atelier/shared";

const settingsSchema = Type.Object({ model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(Type.String()) });

export interface CliModelSettings { model?: string; thinkingLevel?: string }

export function createCliModelSettings(options: {
  agentProvider: string; provider: string; label: string;
  effort(level: string, mapped: string | null | undefined): string | undefined;
}) {
  async function choices(requestedModel?: string, requestedLevel?: string) {
    const runtime = await createPiModelRuntime();
    const available = new Set((await runtime.getAvailable()).map(modelRefValue));
    const favorites = (await getConfiguredModels()).filter((model) => model.provider === options.provider);
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
      const effort = options.effort(level, mapped);
      return effort === undefined ? [] : [effort];
    }))] : [];
    const selectedThinkingLevel = requestedLevel && thinkingLevels.includes(requestedLevel) ? requestedLevel
      : thinkingLevels.includes("medium") ? "medium" : thinkingLevels[0] ?? "";
    return { models, selectedValue, thinkingLevels, selectedThinkingLevel, connectedProvider: runtime.getProviderAuthStatus(options.provider).configured };
  }

  async function renderFooter(context: AgentLaunchFooterContext): Promise<string> {
    return renderLaunchModelSettings({ ...context, agentProvider: options.agentProvider, ...await choices(context.query.get("model") ?? undefined, context.query.get("level") ?? undefined) });
  }

  /** Only available favorites and supported native efforts may reach the CLI. */
  async function prepare(parameters: JsonObject = {}): Promise<CliModelSettings> {
    const settings = { model: parameters.model, thinkingLevel: parameters.thinkingLevel };
    if (!Value.Check(settingsSchema, settings)) throw invalidArguments(`${options.label} model and thinkingLevel must be strings`);
    const { model, thinkingLevel: level } = settings;
    const selection = await choices(model, level);
    if (model && !selection.models.some((item) => modelRefValue(item) === model && item.available)) throw invalidArguments(`Choose an available favorite ${options.label} model`);
    if (level && !selection.thinkingLevels.includes(level)) throw invalidArguments(`Unsupported ${options.label} thinking level`);
    return { model: selection.selectedValue || undefined, thinkingLevel: selection.selectedThinkingLevel || undefined };
  }

  return { renderFooter, prepare };
}
