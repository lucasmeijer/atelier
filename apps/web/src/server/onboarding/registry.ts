export interface OnboardingContribution {
  id: string;
  label: string;
  order?: number;
  isComplete(): Promise<boolean>;
  render(): Promise<string>;
}

const contributions: OnboardingContribution[] = [];

export function registerOnboardingContribution(contribution: OnboardingContribution): void {
  const index = contributions.findIndex((candidate) => candidate.id === contribution.id);
  if (index >= 0) contributions[index] = contribution;
  else contributions.push(contribution);
}

export function listOnboardingContributions(): OnboardingContribution[] {
  return [...contributions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
}
