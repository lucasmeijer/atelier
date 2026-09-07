import { usageWindowTiming, type PacedUsageWindow } from "./usage-window.ts";
import { CodexUsageError, getCodexSubscriptionUsage, type CodexSubscriptionUsage } from "./codex-subscription-usage.ts";
import { createPiModelRuntime } from "./pi-config-models.ts";
import { getUsageLedger, type MeasuredUsage } from "./usage-ledger.ts";

// Only providers with implemented subscription adapters appear in the overview.
export const supportedUsageProviders = [{ id: "openai-codex", label: "OpenAI Codex" }] as const;
export type UsageProvider = typeof supportedUsageProviders[number];
export interface ProviderUsageOverview {
  provider: UsageProvider;
  connected: boolean;
  reported: CodexSubscriptionUsage | null;
  error: string | null;
  measured: MeasuredUsage;
  windows: (PacedUsageWindow & { measured: MeasuredUsage | null })[];
}

export async function connectedUsageProviders(): Promise<UsageProvider[]> {
  const runtime = await createPiModelRuntime();
  return supportedUsageProviders.filter((provider) => runtime.getProviderAuthStatus(provider.id).configured);
}

export async function getProviderUsageOverview(provider: UsageProvider): Promise<ProviderUsageOverview> {
  const ledger = getUsageLedger();
  let reported: CodexSubscriptionUsage | null = null;
  let error: string | null = null;
  const connected = (await connectedUsageProviders()).some((candidate) => candidate.id === provider.id);
  if (connected) {
    try { reported = await getCodexSubscriptionUsage(); } catch (cause) {
      if (!(cause instanceof CodexUsageError)) throw cause;
      error = cause.message;
    }
  }
  const now = new Date();
  const measured = ledger.measure(provider.id, new Date(now.getTime() - 30 * 86400_000), now);
  const checkedAt = reported ? new Date(reported.checkedAt) : now;
  const windows = (reported?.windows ?? []).map((window) => {
    const end = new Date(Math.min(new Date(window.resetsAt).getTime(), checkedAt.getTime()));
    const timing = usageWindowTiming(window, checkedAt);
    const start = new Date(timing.startsAt);
    return { reported: window, measured: start <= end ? ledger.measure(provider.id, start, end) : null, timing };
  });
  return { provider, connected, reported, error, measured, windows };
}
