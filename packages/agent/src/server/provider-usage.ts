import { ModelsError } from "@earendil-works/pi-ai";
import { SubscriptionUsageError, type SubscriptionUsage } from "./subscription-usage.ts";
import { fetchAnthropicSubscriptionUsage } from "./anthropic-subscription-usage.ts";
import { usageWindowTiming, type PacedUsageWindow } from "./usage-window.ts";
import { fetchCodexSubscriptionUsage } from "./codex-subscription-usage.ts";
import { createPiModelRuntime } from "./pi-config-models.ts";
import { getUsageLedger, type MeasuredUsage } from "./usage-ledger.ts";

// Only providers with implemented subscription adapters appear in the overview.
export const supportedUsageProviders = [{ id: "openai-codex", label: "OpenAI Codex" }, { id: "anthropic", label: "Anthropic" }] as const;
export type UsageProvider = typeof supportedUsageProviders[number];
const subscriptionAdapters = {
  "openai-codex": fetchCodexSubscriptionUsage,
  anthropic: fetchAnthropicSubscriptionUsage,
} satisfies Record<UsageProvider["id"], (token: string) => Promise<SubscriptionUsage>>;

export interface ProviderUsageOverview {
  provider: UsageProvider;
  connected: boolean;
  reported: SubscriptionUsage | null;
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
  let reported: SubscriptionUsage | null = null;
  let error: string | null = null;
  const runtime = await createPiModelRuntime();
  const connected = runtime.getProviderAuthStatus(provider.id).configured;
  if (connected) {
    try {
      // Pi owns credential storage and serialized OAuth refresh for both subscriptions.
      const auth = await runtime.getAuth(provider.id, { signal: AbortSignal.timeout(10_000) });
      if (!auth?.auth.apiKey) throw new SubscriptionUsageError(`${provider.label} credentials are unavailable. Reconnect ${provider.label}.`);
      if (auth.source !== "OAuth") throw new SubscriptionUsageError(`${provider.label} subscription usage requires OAuth sign-in, not an API key. Reconnect ${provider.label} with your subscription.`);
      reported = await subscriptionAdapters[provider.id](auth.auth.apiKey);
    } catch (cause) {
      if (cause instanceof ModelsError && cause.code === "oauth") {
        error = `${provider.label} sign-in could not be refreshed. Try again or reconnect ${provider.label}.`;
      } else if (cause instanceof SubscriptionUsageError) {
        error = cause.message;
      } else {
        throw cause;
      }
    }
  }
  const now = new Date();
  const measured = ledger.measure(provider.id, new Date(now.getTime() - 30 * 86400_000), now);
  const checkedAt = reported ? new Date(reported.checkedAt) : now;
  const windows = (reported?.windows ?? []).map((window) => {
    const timing = usageWindowTiming(window, checkedAt);
    if (window.resetsAt === null || timing.state === "unknown") return { reported: window, measured: null, timing };
    const end = new Date(Math.min(new Date(window.resetsAt).getTime(), checkedAt.getTime()));
    const start = new Date(timing.startsAt);
    return { reported: window, measured: start <= end ? ledger.measure(provider.id, start, end) : null, timing };
  });
  return { provider, connected, reported, error, measured, windows };
}
