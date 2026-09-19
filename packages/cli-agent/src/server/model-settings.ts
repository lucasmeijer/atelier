import { Type } from "typebox";
import { Value } from "typebox/value";
import { invalidArguments, type JsonObject } from "@atelier/core";
import { createPiModelRuntime, providerAvailability, getConfiguredModels, hasConnectedModelProvider, modelRefValue, modelThinkingLevels, renderLaunchModelSettings, type ComposerModelOption, type ModelRef } from "@atelier/llm/server";
import type { AgentLaunchFooterContext } from "@atelier/shared";

const settingsSchema = Type.Object({ model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(Type.String()) });

export interface CliModelSettings { model?: string; thinkingLevel?: string }

export function createCliModelSettings(options: {
  agentProvider: string; label: string;
  /** Omit provider to share favorites across all connected providers. */
  provider?: string;
  unavailableReason?(runtime: Awaited<ReturnType<typeof createPiModelRuntime>>, model: ModelRef): Promise<string | undefined>;
  effort(level: string, mapped: string | null | undefined): string | undefined;
}) {
  async function choices(requestedModel?: string, requestedLevel?: string) {
    const runtime = await createPiModelRuntime();
    const favorites = (await getConfiguredModels()).filter((model) => !options.provider || model.provider === options.provider);
    const availability = await providerAvailability(runtime, favorites.map((model) => model.provider));
    const models: ComposerModelOption[] = await Promise.all(favorites.map(async (model) => {
      const { modelIds, connection } = availability.get(model.provider)!;
      const unavailableReason = modelIds.has(model.id)
        ? await options.unavailableReason?.(runtime, model)
        : connection === "needs_attention" ? "Reconnect in Settings → Models" : "Model unavailable for this account";
      return { ...model, name: model.label, selected: false, available: !unavailableReason, unavailableReason };
    }));
    const selected = models.find((model) => model.available && modelRefValue(model) === requestedModel)
      ?? models.find((model) => model.available);
    if (selected) selected.selected = true;
    const selectedValue = selected ? modelRefValue(selected) : "";
    const selectedModel = selected ? runtime.getModel(selected.provider, selected.id) : undefined;
    // Adapters translate Pi thinking levels when their CLI uses provider-native efforts.
    const thinkingLevels = selected && selectedModel ? [...new Set((await modelThinkingLevels(selected)).flatMap((level) => {
      const mapped = selectedModel.thinkingLevelMap?.[level];
      const effort = options.effort(level, mapped);
      return effort === undefined ? [] : [effort];
    }))] : [];
    const selectedThinkingLevel = requestedLevel && thinkingLevels.includes(requestedLevel) ? requestedLevel
      : thinkingLevels.includes("medium") ? "medium" : thinkingLevels[0] ?? "";
    return { models, selectedValue, thinkingLevels, selectedThinkingLevel, connectedProvider: options.provider ? runtime.getProviderAuthStatus(options.provider).configured : hasConnectedModelProvider(runtime) };
  }

  async function renderFooter(context: AgentLaunchFooterContext): Promise<string> {
    return renderLaunchModelSettings({ ...context, agentProvider: options.agentProvider, ...await choices(context.query.get("model") ?? undefined, context.query.get("level") ?? undefined) });
  }

  /** Only available favorites and supported thinking levels may reach the CLI. */
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
