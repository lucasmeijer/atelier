import { expect, test } from "bun:test";
import { subscriptionCliFiles } from "../../src/server/subscription-cli.ts";

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
