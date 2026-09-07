import { SubscriptionUsageError, type SubscriptionUsage } from "./subscription-usage.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const claimsSchema = Type.Object({ "https://api.openai.com/auth": Type.Object({ chatgpt_account_id: Type.String({ minLength: 1 }) }) });
const windowSchema = Type.Object({
  used_percent: Type.Number({ minimum: 0, maximum: 100 }),
  limit_window_seconds: Type.Integer({ minimum: 1 }),
  reset_at: Type.Integer({ minimum: 0, maximum: 8640000000000 }),
});
const limitsSchema = Type.Object({
  allowed: Type.Boolean(),
  limit_reached: Type.Boolean(),
  primary_window: Type.Optional(Type.Union([windowSchema, Type.Null()])),
  secondary_window: Type.Optional(Type.Union([windowSchema, Type.Null()])),
});
const payloadSchema = Type.Object({
  plan_type: Type.String(),
  rate_limit: Type.Optional(Type.Union([limitsSchema, Type.Null()])),
  code_review_rate_limit: Type.Optional(Type.Union([limitsSchema, Type.Null()])),
  additional_rate_limits: Type.Optional(Type.Union([Type.Array(Type.Object({
    limit_name: Type.String(), metered_feature: Type.String(),
    rate_limit: Type.Optional(Type.Union([limitsSchema, Type.Null()])),
  })), Type.Null()])),
});

/** ChatGPT's account endpoint, also used by the Codex CLI. Not a public, versioned API. */
export async function fetchCodexSubscriptionUsage(accessToken: string, fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<SubscriptionUsage> {
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString());
  } catch {
    throw new SubscriptionUsageError("OpenAI credentials are invalid. Reconnect OpenAI Codex.");
  }
  if (!Value.Check(claimsSchema, claims)) throw new SubscriptionUsageError("OpenAI credentials have no account ID. Reconnect OpenAI Codex.");
  let response: Response;
  try {
    response = await fetcher("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${accessToken}`, "ChatGPT-Account-Id": claims["https://api.openai.com/auth"].chatgpt_account_id, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    throw new SubscriptionUsageError("Could not reach OpenAI to check subscription usage. Try again.");
  }
  if (response.status === 401) throw new SubscriptionUsageError("OpenAI rejected the credentials. Reconnect OpenAI Codex.");
  if (!response.ok) throw new SubscriptionUsageError(`OpenAI usage is unavailable (HTTP ${response.status}). Try again later.`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new SubscriptionUsageError("OpenAI returned an invalid usage response."); }
  if (!Value.Check(payloadSchema, payload)) throw new SubscriptionUsageError("OpenAI returned an unrecognized usage response.");
  return normalizeUsage(payload);
}

function normalizeUsage(payload: Static<typeof payloadSchema>): SubscriptionUsage {
  const limits = payload.rate_limit;
  return {
    plan: payload.plan_type,
    checkedAt: new Date().toISOString(),
    allowed: limits?.allowed ?? null,
    limitReached: limits?.limit_reached ?? null,
    windows: [
      { limit_name: "Codex", metered_feature: null, rate_limit: limits },
      ...(payload.code_review_rate_limit ? [{ limit_name: "Code review", metered_feature: "code_review", rate_limit: payload.code_review_rate_limit }] : []),
      ...payload.additional_rate_limits ?? [],
    ].flatMap((group) => (["primary", "secondary"] as const).flatMap((kind) => {
      const window = group.rate_limit?.[`${kind}_window`];
      return window ? [{ limitName: group.limit_name, meteredFeature: group.metered_feature, kind, usedPercent: window.used_percent, durationSeconds: window.limit_window_seconds, resetsAt: new Date(window.reset_at * 1000).toISOString() }] : [];
    })),
  };
}
