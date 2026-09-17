import type { JsonObject } from "@atelier/core";
import { expect, test } from "bun:test";
import { fetchAnthropicSubscriptionUsage } from "../../src/server/anthropic-subscription-usage.ts";

const window = { utilization: 72, resets_at: "2026-09-03T12:00:00+00:00" };
const payload = { five_hour: window, seven_day: { ...window, utilization: 0 } };
const fetcher = (body: JsonObject, status = 200) => async () => Response.json(body, { status });

test("requests Claude account usage with OAuth and normalizes main and model windows", async () => {
  const usage = await fetchAnthropicSubscriptionUsage("secret", async (url, init) => {
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ ...payload, seven_day_sonnet: { ...window, utilization: 100 }, seven_day_opus: null });
  });
  expect(usage.windows).toEqual([
    { limitName: "Claude", meteredFeature: null, kind: "primary", usedPercent: 72, durationSeconds: 18000, resetsAt: "2026-09-03T12:00:00.000Z" },
    { limitName: "Claude", meteredFeature: null, kind: "secondary", usedPercent: 0, durationSeconds: 604800, resetsAt: "2026-09-03T12:00:00.000Z" },
    { limitName: "Sonnet", meteredFeature: "sonnet", kind: "secondary", usedPercent: 100, durationSeconds: 604800, resetsAt: "2026-09-03T12:00:00.000Z" },
  ]);
  expect(usage.plan).toBeNull();
  expect(usage.allowed).toBeNull();
  expect(usage.limitReached).toBeNull();
});

test("null buckets are omitted but null resets preserve usage; monetary extra usage isn't a window", async () => {
  const usage = await fetchAnthropicSubscriptionUsage("secret", fetcher({ five_hour: null, seven_day: { utilization: 0, resets_at: null }, extra_usage: { is_enabled: true, utilization: 50, monthly_limit: 1000 } }));
  expect(usage.windows).toEqual([{ limitName: "Claude", meteredFeature: null, kind: "secondary", usedPercent: 0, durationSeconds: 604800, resetsAt: null }]);
});

test("preserves additional known weekly feature buckets", async () => {
  const usage = await fetchAnthropicSubscriptionUsage("secret", fetcher({ ...payload, seven_day_opus: window, seven_day_oauth_apps: window, seven_day_cowork: window }));
  expect(usage.windows.slice(2).map((window) => window.meteredFeature)).toEqual(["opus", "oauth_apps", "cowork"]);
});

test("rejects malformed upstream usage rather than inventing values", async () => {
  for (const body of [{}, { ...payload, five_hour: { ...window, utilization: -1 } }, { ...payload, five_hour: { ...window, utilization: 101 } }, { ...payload, seven_day: { ...window, resets_at: "tomorrow" } }, { ...payload, seven_day_opus: { utilization: "5", resets_at: null } }]) {
    await expect(fetchAnthropicSubscriptionUsage("secret", fetcher(body))).rejects.toThrow("unrecognized usage response");
  }
});

test("HTTP failures are actionable and don't leak response bodies", async () => {
  for (const status of [401, 403, 429, 500]) {
    await expect(fetchAnthropicSubscriptionUsage("secret", fetcher({ secret: "private" }, status))).rejects.toThrow(status === 401 ? "Reconnect Anthropic" : `HTTP ${status}`);
  }
});

test("network and invalid JSON failures are explicit", async () => {
  await expect(fetchAnthropicSubscriptionUsage("secret", async () => { throw new Error("private"); })).rejects.toThrow("Could not reach Anthropic");
  await expect(fetchAnthropicSubscriptionUsage("secret", async () => new Response("private"))).rejects.toThrow("invalid usage response");
});

// Real response shape: signed-in subscriptions can report 0% with no reset yet.
test("retains both main limits when Anthropic has not assigned reset timestamps", async () => {
  for (const utilization of [0, 42]) {
    const bucket = { utilization, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null };
    const usage = await fetchAnthropicSubscriptionUsage("secret", fetcher({ five_hour: bucket, seven_day: bucket, seven_day_opus: null, seven_day_sonnet: null }));
    expect(usage.windows).toHaveLength(2);
    expect(usage.windows.map(({ usedPercent, resetsAt }) => ({ usedPercent, resetsAt }))).toEqual([
      { usedPercent: utilization, resetsAt: null }, { usedPercent: utilization, resetsAt: null },
    ]);
  }
});
