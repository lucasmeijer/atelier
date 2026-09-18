import { expect, test } from "bun:test";
import { ModelsError } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { providerConnections } from "../../src/server/provider-connections.ts";

function runtime(getAuth: ModelRuntime["getAuth"], type: "oauth" | "api_key" = "oauth") {
  return {
    getProviders: () => [{ id: "anthropic" }],
    getProviderAuthStatus: () => ({ configured: true, source: "stored" as const }),
    listCredentials: async () => [{ providerId: "anthropic", type }],
    getAuth,
  };
}

test("resolves OAuth so expired access tokens can refresh before reporting connected", async () => {
  let checked = false;
  const result = await providerConnections(runtime(async () => {
    checked = true;
    return { auth: { apiKey: "refreshed" }, source: "OAuth" };
  }));
  expect(checked).toBe(true);
  expect(result.get("anthropic")).toBe("connected");
});

test("failed OAuth refresh needs attention", async () => {
  const result = await providerConnections(runtime(async () => { throw new ModelsError("oauth", "refresh rejected"); }));
  expect(result.get("anthropic")).toBe("needs_attention");
});

test("credentials removed during resolution are not connected", async () => {
  expect((await providerConnections(runtime(async () => undefined))).get("anthropic")).toBe("disconnected");
});

test("API key status does not execute auth resolution", async () => {
  const result = await providerConnections(runtime(async () => { throw new Error("must not resolve"); }, "api_key"));
  expect(result.get("anthropic")).toBe("connected");
});

test("unexpected storage errors remain visible", async () => {
  await expect(providerConnections(runtime(async () => { throw new ModelsError("auth", "storage failed"); }))).rejects.toThrow("storage failed");
});

test("unconfigured providers do not attempt renewal", async () => {
  const disconnected = {
    ...runtime(async () => { throw new Error("must not resolve"); }),
    getProviderAuthStatus: () => ({ configured: false }),
  };
  expect((await providerConnections(disconnected)).get("anthropic")).toBe("disconnected");
});

test("runtime credentials take precedence over stored OAuth", async () => {
  const overridden = {
    ...runtime(async () => { throw new Error("must not resolve"); }),
    getProviderAuthStatus: () => ({ configured: true, source: "runtime" as const }),
  };
  expect((await providerConnections(overridden)).get("anthropic")).toBe("connected");
});

test("a successful retry clears the attention state", async () => {
  let fail = true;
  const provider = runtime(async () => {
    if (fail) throw new ModelsError("oauth", "temporary failure");
    return { auth: { apiKey: "refreshed" }, source: "OAuth" };
  });
  expect((await providerConnections(provider)).get("anthropic")).toBe("needs_attention");
  fail = false;
  expect((await providerConnections(provider)).get("anthropic")).toBe("connected");
});
