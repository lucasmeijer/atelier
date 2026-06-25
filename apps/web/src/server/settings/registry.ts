import type { SettingsContribution } from "@atelier/shared";

const contributions: SettingsContribution[] = [];

export function registerSettingsContribution(contribution: SettingsContribution): void {
  const index = contributions.findIndex((candidate) => candidate.id === contribution.id);
  if (index >= 0) contributions[index] = contribution;
  else contributions.push(contribution);
}

export function listSettingsContributions(): SettingsContribution[] {
  return [...contributions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
}
