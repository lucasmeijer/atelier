export type SubscriptionUsage = {
  plan: string | null;
  checkedAt: string;
  allowed: boolean | null;
  limitReached: boolean | null;
  windows: { limitName: string; meteredFeature: string | null; kind: "primary" | "secondary"; usedPercent: number; durationSeconds: number; resetsAt: string | null }[];
};


/** Expected provider/authentication failures that can be shown alongside local usage. */
export class SubscriptionUsageError extends Error {}
