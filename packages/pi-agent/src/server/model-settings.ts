import { createCliModelSettings, type CliModelSettings } from "@atelier/cli-agent/server";
import { piCliModelUnavailableReason } from "./pi-cli-bridge.ts";
import type { JsonObject } from "@atelier/core";
import { piModelSetupRequired } from "./auth.ts";

const sharedSettings = createCliModelSettings({
  agentProvider: "pi", label: "Pi",
  // Pi uses its own abstract thinking levels, not the provider-native efforts.
  effort: (level) => level,
  unavailableReason: piCliModelUnavailableReason,
});

async function preparePiModelSettings(parameters: JsonObject = {}): Promise<CliModelSettings> {
  const settings = await sharedSettings.prepare(parameters);
  if (!settings.model) throw piModelSetupRequired();
  return settings;
}

export const piModelSettings = { ...sharedSettings, prepare: preparePiModelSettings };
