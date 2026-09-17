import { Type } from "typebox";
import { Value } from "typebox/value";
import { SubscriptionUsageError, type SubscriptionUsage } from "./subscription-usage.ts";

const windowSchema = Type.Union([Type.Object({
  utilization: Type.Number({ minimum: 0, maximum: 100 }),
  resets_at: Type.Union([Type.String(), Type.Null()]),
}), Type.Null()]);
const payloadSchema = Type.Object({
  five_hour: windowSchema,
  seven_day: windowSchema,
  seven_day_opus: Type.Optional(windowSchema),
  seven_day_sonnet: Type.Optional(windowSchema),
  seven_day_oauth_apps: Type.Optional(windowSchema),
  seven_day_cowork: Type.Optional(windowSchema),
});
const windows = [
  { key: "five_hour", label: "Claude", feature: null, duration: 18000, kind: "primary" },
  { key: "seven_day", label: "Claude", feature: null, duration: 604800, kind: "secondary" },
  { key: "seven_day_opus", label: "Opus", feature: "opus", duration: 604800, kind: "secondary" },
  { key: "seven_day_sonnet", label: "Sonnet", feature: "sonnet", duration: 604800, kind: "secondary" },
  { key: "seven_day_oauth_apps", label: "OAuth apps", feature: "oauth_apps", duration: 604800, kind: "secondary" },
  { key: "seven_day_cowork", label: "Cowork", feature: "cowork", duration: 604800, kind: "secondary" },
] as const;

/** Claude's OAuth account endpoint. Not a public, versioned API.
 * Durations follow the named buckets; extra_usage is monetary, not a paced window. */
export async function fetchAnthropicSubscriptionUsage(accessToken: string, fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<SubscriptionUsage> {
  let response: Response;
  try {
    response = await fetcher("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    throw new SubscriptionUsageError("Could not reach Anthropic to check subscription usage. Try again.");
  }
  if (response.status === 401) throw new SubscriptionUsageError("Anthropic rejected the credentials. Reconnect Anthropic.");
  if (response.status === 403) throw new SubscriptionUsageError("Anthropic denied subscription usage access (HTTP 403). Reconnect Anthropic with subscription OAuth sign-in.");
  if (!response.ok) throw new SubscriptionUsageError(`Anthropic usage is unavailable (HTTP ${response.status}). Try again later.`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new SubscriptionUsageError("Anthropic returned an invalid usage response."); }
  if (!Value.Check(payloadSchema, payload)) throw new SubscriptionUsageError("Anthropic returned an unrecognized usage response.");
  const reported: SubscriptionUsage["windows"] = [];
  for (const bucket of windows) {
    const window = payload[bucket.key];
    // A reported bucket is still meaningful without reset timing.
    if (!window) continue;
    const reset = window.resets_at === null ? null : new Date(window.resets_at);
    if (reset !== null && !Number.isFinite(reset.getTime())) throw new SubscriptionUsageError("Anthropic returned an unrecognized usage response.");
    reported.push({ limitName: bucket.label, meteredFeature: bucket.feature, kind: bucket.kind, usedPercent: window.utilization, durationSeconds: bucket.duration, resetsAt: reset?.toISOString() ?? null });
  }
  // The endpoint reports neither plan nor an account-wide permission decision.
  return { plan: null, checkedAt: new Date().toISOString(), allowed: null, limitReached: null, windows: reported };
}
