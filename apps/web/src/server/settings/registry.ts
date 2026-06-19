export interface SettingsActionContext {
  request: Request;
  url: URL;
}

export interface SettingsContribution {
  id: string;
  label: string;
  icon?: string;
  order?: number;
  render(): Promise<string>;
  handleAction?(context: SettingsActionContext): Promise<Response | undefined>;
}

const contributions: SettingsContribution[] = [];

export function registerSettingsContribution(contribution: SettingsContribution): void {
  const index = contributions.findIndex((candidate) => candidate.id === contribution.id);
  if (index >= 0) contributions[index] = contribution;
  else contributions.push(contribution);
}

export function listSettingsContributions(): SettingsContribution[] {
  return [...contributions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
}
