import type { JsonObject } from "@atelier/core";
import { expect, test } from "bun:test";
import { fetchCodexSubscriptionUsage } from "../../src/server/codex-subscription-usage.ts";

const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).toString("base64url")}.signature`;
const window = { used_percent: 72, limit_window_seconds: 18000, reset_at: 1800000000 };
const payload = { plan_type: "plus", rate_limit: { allowed: true, limit_reached: false, primary_window: window, secondary_window: { ...window, used_percent: 0, limit_window_seconds: 604800 } } };
const fetcher = (body: JsonObject, status = 200) => (async () => Response.json(body, { status }));

test("requests account-wide usage with resolved OAuth credentials and normalizes both windows", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, (async (url, init) => {
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("chatgpt-account-id")).toBe("account-123");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json(payload);
  }));
  expect(usage.plan).toBe("plus");
  expect(usage.windows).toEqual([
    { limitName: "Codex", meteredFeature: null, kind: "primary", usedPercent: 72, durationSeconds: 18000, resetsAt: new Date(1800000000000).toISOString() },
    { limitName: "Codex", meteredFeature: null, kind: "secondary", usedPercent: 0, durationSeconds: 604800, resetsAt: new Date(1800000000000).toISOString() },
  ]);
  expect(usage.allowed).toBe(true);
});

test("missing limits are unknown, not zero usage", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, fetcher({ plan_type: "pro", rate_limit: null }));
  expect(usage.windows).toEqual([]);
  expect(usage.allowed).toBeNull();
  expect(usage.limitReached).toBeNull();
});

test("preserves an exhausted allowance and a missing secondary window", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, fetcher({ plan_type: "plus", rate_limit: { allowed: false, limit_reached: true, primary_window: { ...window, used_percent: 100 } } }));
  expect(usage.limitReached).toBe(true);
  expect(usage.windows).toHaveLength(1);
  expect(usage.windows[0]!.usedPercent).toBe(100);
});

test("rejects malformed credentials before making a request", async () => {
  for (const token of ["invalid", "a.e30.b"]) {
    await expect(fetchCodexSubscriptionUsage(token, (async () => { throw new Error("must not fetch"); }))).rejects.toThrow("Reconnect OpenAI Codex");
  }
});

test("rejects malformed upstream data rather than inventing usage", async () => {
  for (const body of [{}, { ...payload, rate_limit: { ...payload.rate_limit, primary_window: { ...window, used_percent: -1 } } }, { ...payload, rate_limit: { ...payload.rate_limit, primary_window: { ...window, reset_at: "tomorrow" } } }]) {
    await expect(fetchCodexSubscriptionUsage(token, fetcher(body))).rejects.toThrow("unrecognized usage response");
  }
});

test("HTTP errors do not leak upstream bodies or credentials", async () => {
  for (const status of [401, 403, 429, 500]) {
    await expect(fetchCodexSubscriptionUsage(token, fetcher({ secret: token }, status))).rejects.toThrow(status === 401 ? "Reconnect OpenAI Codex" : `HTTP ${status}`);
  }
});

test("reports network and JSON failures", async () => {
  await expect(fetchCodexSubscriptionUsage(token, (async () => { throw new Error("secret"); }))).rejects.toThrow("Could not reach OpenAI");
  await expect(fetchCodexSubscriptionUsage(token, (async () => new Response("not JSON")))).rejects.toThrow("invalid usage response");
});


test("keeps all reported durations and additional feature windows without assuming monthly limits", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, fetcher({
    ...payload,
    additional_rate_limits: [{ limit_name: "Long context", metered_feature: "codex_long_context", rate_limit: {
      allowed: true, limit_reached: false,
      primary_window: { ...window, limit_window_seconds: 30 * 86400, used_percent: 25 },
      secondary_window: null,
    } }],
  }));
  expect(usage.windows.map((window) => window.durationSeconds)).toEqual([18000, 604800, 2592000]);
  expect(usage.windows[2]!.limitName).toBe("Long context");
  expect(usage.windows[2]!.meteredFeature).toBe("codex_long_context");
});


test("includes code-review windows when OpenAI reports them", async () => {
  const usage = await fetchCodexSubscriptionUsage(token, fetcher({
    plan_type: "pro", rate_limit: null,
    code_review_rate_limit: { allowed: true, limit_reached: false, primary_window: { ...window, limit_window_seconds: 604800 } },
    additional_rate_limits: null,
  }));
  expect(usage.windows).toHaveLength(1);
  expect(usage.windows[0]!.limitName).toBe("Code review");
  expect(usage.windows[0]!.meteredFeature).toBe("code_review");
});
