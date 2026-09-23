import { expect, test } from "bun:test";
import { createWorkspaceSecretContext } from "@atelier/proxy-egress/server";
import { maskCodexAccountDiscovery, registerSubscriptionCli, subscriptionCliFiles } from "../../src/server/subscription-cli.ts";

test("Codex receives ChatGPT auth, not API-key auth or refresh credentials", () => {
  const file = subscriptionCliFiles().find((file) => file.provider === "openai-codex")!;
  const auth = JSON.parse(file.content);
  expect(auth.auth_mode).toBe("chatgpt");
  expect(auth.OPENAI_API_KEY).toBeNull();
  expect(auth.tokens.access_token).toBe(file.marker);
  expect(auth.tokens.refresh_token).toBe("");
  const parts = auth.tokens.id_token.split(".");
  expect(parts).toHaveLength(3);
  expect(parts.every(Boolean)).toBe(true);
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  expect(claims["https://api.openai.com/auth"].chatgpt_account_id).toBe(auth.tokens.account_id);
});

test("Codex routing discovery sees its placeholder as the selected account without changing other workspaces", async () => {
  const response = new Response(JSON.stringify({ accounts: [
    { id: "account-123", workspace_backend_origin: "https://chatgpt.com", account_routing_override: "NO_CONSTRAINT" },
    { id: "other-account" },
  ], account_ordering: ["other-account", "account-123"], default_account_id: "account-123" }), { headers: { "content-length": "200", "content-type": "application/json" } });
  const translated = await maskCodexAccountDiscovery(response, "account-123");
  const selected = JSON.parse(subscriptionCliFiles().find(file => file.provider === "openai-codex")!.content).tokens.account_id;
  expect(await translated.json()).toEqual({ accounts: [
    { id: selected, workspace_backend_origin: "https://chatgpt.com", account_routing_override: "NO_CONSTRAINT" },
    { id: "other-account" },
  ], account_ordering: ["other-account", selected], default_account_id: selected });
  expect(translated.headers.has("content-length")).toBe(false);
  expect((await response.json()).accounts[0].id).toBe("account-123");
});

test("workspace proxy translates Codex discovery only on ChatGPT's account endpoint", async () => {
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).toString("base64url")}.signature`;
  registerSubscriptionCli(async () => ({ getAuth: async () => ({ source: "OAuth", auth: { apiKey: token } }) }) as any);
  const context = await createWorkspaceSecretContext("codex-discovery-test");
  const request = await context.hooks.onRequest!(new Request("https://chatgpt.com/backend-api/wham/accounts/check", { headers: { authorization: "Bearer atelier-subscription-codex-access", "chatgpt-account-id": "atelier-subscription-codex-account" } })) as Request;
  expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(request.headers.get("chatgpt-account-id")).toBe("account-123");
  const upstream = new Response(JSON.stringify({ accounts: [{ id: "account-123" }] }));
  const result = await context.hooks.onResponse!(upstream, request) as Response;
  expect((await result.json()).accounts[0].id).toBe("atelier-subscription-codex-account");
  const unrelated = new Response("untouched");
  expect(await context.hooks.onResponse!(unrelated, new Request("https://chatgpt.com/backend-api/wham/usage"))).toBe(unrelated);
});

test("invalid account discovery remains an upstream response", async () => {
  const response = new Response("not JSON");
  expect(await maskCodexAccountDiscovery(response, "account-123")).toBe(response);
});

test("Claude Code receives inference-scoped OAuth placeholders", () => {
  const file = subscriptionCliFiles().find((file) => file.provider === "anthropic")!;
  expect(file.path).toBe(".claude/.credentials.json");
  const auth = JSON.parse(file.content).claudeAiOauth;
  expect(auth.accessToken).toBe(file.marker);
  // Claude Code treats "" as a dead refresh token and reports an expired login.
  expect(auth.refreshToken).toBeNull();
  expect(auth.scopes).toContain("user:inference");
  expect(auth.expiresAt).toBeGreaterThan(Date.now());
});
