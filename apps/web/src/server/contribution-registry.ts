export interface OrderedContribution {
  id: string;
  label: string;
  order?: number;
}

export function createContributionRegistry<T extends OrderedContribution>(): { register(contribution: T): void; list(): T[] } {
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
