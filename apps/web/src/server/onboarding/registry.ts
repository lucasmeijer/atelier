import { createContributionRegistry } from "../contribution-registry.ts";

export interface OnboardingContribution {
  id: string;
  label: string;
  order?: number;
  isComplete(): Promise<boolean>;
  render(): Promise<string>;
}

const registry = createContributionRegistry<OnboardingContribution>();

export function registerOnboardingContribution(contribution: OnboardingContribution): void {
  registry.register(contribution);
}

export function listOnboardingContributions(): OnboardingContribution[] {
  return registry.list();
}
