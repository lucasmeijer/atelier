import type { SettingsContribution } from "@atelier/shared";
import { createContributionRegistry } from "../contribution-registry.ts";

const registry = createContributionRegistry<SettingsContribution>();

export function registerSettingsContribution(contribution: SettingsContribution): void {
  registry.register(contribution);
}

export function listSettingsContributions(): SettingsContribution[] {
  return registry.list();
}
