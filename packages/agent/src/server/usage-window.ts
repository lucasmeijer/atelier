import type { CodexSubscriptionUsage } from "./codex-subscription-usage.ts";

export interface UsageWindowTiming {
  /** Inferred from the provider's reset timestamp minus its window duration. */
  startsAt: string;
  elapsedPercent: number;
  state: "not-started" | "active" | "reset-due";
  /** Usage minus elapsed time, in percentage points. Not meaningful outside the active window. */
  paceDifferencePoints: number | null;
  /** Signed distance along the linear allowance schedule; positive means consumption is ahead. */
  paceDifferenceSeconds: number | null;
}

/** A linear pacing reference, not a prediction of provider allowance consumption. */
export function usageWindowTiming(window: CodexSubscriptionUsage["windows"][number], at: Date): UsageWindowTiming {
  const reset = new Date(window.resetsAt).getTime();
  const duration = window.durationSeconds * 1000;
  const start = reset - duration;
  const elapsedPercent = Math.max(0, Math.min(100, (at.getTime() - start) / duration * 100));
  const state = at.getTime() < start ? "not-started" : at.getTime() >= reset ? "reset-due" : "active";
  const paceDifferencePoints = state === "active" ? window.usedPercent - elapsedPercent : null;
  return { startsAt: new Date(start).toISOString(), elapsedPercent, state, paceDifferencePoints, paceDifferenceSeconds: paceDifferencePoints === null ? null : paceDifferencePoints / 100 * window.durationSeconds };
}

export interface PacedUsageWindow {
  reported: CodexSubscriptionUsage["windows"][number];
  timing: UsageWindowTiming;
}

/** Surface the most urgent active, used allowance, not an unused feature bucket.
 * Ties prefer the more consumed allowance. When all are unused, show the main allowance. */
export function selectPacingWindow(windows: readonly PacedUsageWindow[]): PacedUsageWindow | undefined {
  const active = windows.filter((window) => window.timing.state === "active");
  const used = active.filter((window) => window.reported.usedPercent > 0);
  if (!used.length) return active.find((window) => window.reported.meteredFeature === null) ?? active[0];
  return used.reduce<PacedUsageWindow | undefined>((selected, window) => {
    if (!selected) return window;
    const difference = window.timing.paceDifferencePoints! - selected.timing.paceDifferencePoints!;
    return difference > 0 || (difference === 0 && window.reported.usedPercent > selected.reported.usedPercent) ? window : selected;
  }, undefined);
}
