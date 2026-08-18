export interface OrderedContribution {
  id: string;
  label: string;
  order?: number;
}

export interface ContributionRegistry<T extends OrderedContribution> {
  register(contribution: T): void;
  list(): T[];
}

export function createContributionRegistry<T extends OrderedContribution>(): ContributionRegistry<T> {
  const contributions: T[] = [];
  return {
    register(contribution) {
      const index = contributions.findIndex((candidate) => candidate.id === contribution.id);
      if (index >= 0) contributions[index] = contribution;
      else contributions.push(contribution);
    },
    list() {
      return [...contributions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
    },
  };
}
