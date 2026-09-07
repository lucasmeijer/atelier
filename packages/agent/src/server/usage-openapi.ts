import type { JsonObject } from "@atelier/core";
import { supportedUsageProviders } from "./provider-usage.ts";

const errorResponse = { description: "Request failed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
const htmlSurfaceResponses = (description: string) => ({ "200": { description, content: { "text/html": { schema: { type: "string" } } } }, "400": errorResponse, "404": errorResponse });
const jsonAndHtmlResponse = (description: string, schema: JsonObject) => ({
  ...htmlSurfaceResponses(description),
  "200": { description, content: { "application/json": { schema }, "text/html": { schema: { type: "string" } } } },
});

const measuredUsageSchema = {
  type: "object",
  properties: {
    from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, trackingSince: { type: "string", format: "date-time" },
    partialCoverage: { type: "boolean" }, requests: { type: "integer" }, input: { type: "number" }, output: { type: "number" },
    cacheRead: { type: "number" }, cacheWrite: { type: "number" }, totalTokens: { type: "number" },
  },
};
const reportedUsageWindowSchema = {
  type: "object",
  properties: {
    limitName: { type: "string" }, meteredFeature: { type: ["string", "null"] }, kind: { enum: ["primary", "secondary"] },
    usedPercent: { type: "number" }, durationSeconds: { type: "integer" }, resetsAt: { type: ["string", "null"], format: "date-time", description: "Null when the provider has not reported reset timing; usage is still reported." },
  },
};
const providerUsageSchema = {
  type: "object",
  properties: {
    provider: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } } }, connected: { type: "boolean" }, error: { type: ["string", "null"] },
    reported: { type: ["object", "null"], properties: {
      plan: { type: ["string", "null"], description: "Null when the provider does not report the subscription plan." }, checkedAt: { type: "string", format: "date-time" }, allowed: { type: ["boolean", "null"] }, limitReached: { type: ["boolean", "null"] },
      windows: { type: "array", items: reportedUsageWindowSchema },
    } },
    measured: { ...measuredUsageSchema, description: "Last 30 days across this installation and provider (not account-specific). Tokens are attributed to response completion. Output includes reasoning; input excludes cache reads and writes." },
    windows: { type: "array", items: { type: "object", properties: {
      reported: reportedUsageWindowSchema,
      measured: { ...measuredUsageSchema, type: ["object", "null"], description: "All provider tokens in the reported interval, not feature-filtered; null if reset timing is unknown or the interval has not started. Not convertible to subscription percentages." },
      timing: { type: "object", description: "Linear pacing reference at reported.checkedAt. Start is inferred from reset minus duration, not explicitly reported by the provider. When reset timing is unknown, state is unknown and all timing values are null.", properties: {
        startsAt: { type: ["string", "null"], format: "date-time" }, elapsedPercent: { type: ["number", "null"], minimum: 0, maximum: 100 },
        paceDifferenceSeconds: { type: ["number", "null"], description: "Signed distance along the linear allowance schedule: paceDifferencePoints / 100 × durationSeconds. Positive means usage is ahead of pace; negative means behind. Not a forecast. Null outside an active window." },
        state: { enum: ["unknown", "not-started", "active", "reset-due"] }, paceDifferencePoints: { type: ["number", "null"], description: "Usage minus elapsed-time percentage, in percentage points. Positive is above linear pace. Null outside an active window." },
      } },
    } } },
  },
};

export const usageOpenApiPaths = {
  "/usage": { get: {
    summary: "Open Usage or inspect all connected, supported providers",
    description: "HTML opens the Usage dialog in the Atelier shell. JSON includes provider-reported subscription windows and installation-local token measurements. Supports OpenAI Codex and Anthropic subscriptions. Anthropic requires OAuth sign-in, not an API key. Provider failures are explicit per-provider errors and do not hide local measurements.",
    responses: jsonAndHtmlResponse("Usage overview", { type: "object", properties: { providers: { type: "array", items: providerUsageSchema } } }),
  } },
  "/usage/button": { get: { summary: "Usage button perimeter for the selected provider", parameters: [{ name: "provider", in: "query", required: false, schema: { type: "string" } }], responses: htmlSurfaceResponses("Server-rendered button frame. Clockwise Time/Usage comparison ring for the greatest pacing difference among active used windows (the main allowance if all are unused). Ties prefer higher usage. Green is Time beyond Usage; red is Usage beyond Time. Omitted provider uses the saved most-recent model provider. No ring for unknown or unsupported limits.") } },
  "/usage/overview": { get: { summary: "Refresh the server-rendered Usage overview frame", responses: htmlSurfaceResponses("Usage overview frame") } },
  "/usage/providers/{provider}": { get: {
    summary: "Refresh subscription limits and local usage for a provider",
    parameters: [{ name: "provider", in: "path", required: true, schema: { type: "string", enum: supportedUsageProviders.map((provider) => provider.id) } }],
    responses: jsonAndHtmlResponse("Provider usage, including any provider error", providerUsageSchema),
  } },
} satisfies Record<string, JsonObject>;
