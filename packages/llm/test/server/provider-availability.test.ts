import { expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelsError } from "@earendil-works/pi-ai";
import { providerAvailability } from "../../src/server/provider-availability.ts";

test("OAuth rejection is isolated and retried on the next resolution", async () => {
  const catalogue = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const grok = catalogue.getModels("xai")[0]!;
  let rejected = true;
  const checked: string[] = [];
  const runtime = {
    getAvailable: async (provider?: string) => {
      checked.push(provider!);
      if (provider === "anthropic" && rejected) throw new ModelsError("oauth", "invalid_grant: Refresh token not found or invalid");
      return provider === "xai" ? [grok] : [];
    },
    checkAuth: async () => ({ type: "api_key" as const }),
  };
  const result = await providerAvailability(runtime, ["anthropic", "xai", "xai"]);
  expect(result.get("anthropic")?.connection).toBe("needs_attention");
  expect(result.get("xai")?.connection).toBe("connected");
  expect(result.get("xai")!.modelIds.has(grok.id)).toBe(true);
  expect(result.get("anthropic")!.modelIds.size).toBe(0);
  expect(checked).toEqual(["anthropic", "xai"]);
  rejected = false;
  expect((await providerAvailability(runtime, ["anthropic"])).get("anthropic")?.connection).toBe("connected");
});

test("OAuth rejection during auth checking is isolated", async () => {
  const result = await providerAvailability({ getAvailable: async () => [], checkAuth: async () => { throw new ModelsError("oauth", "rejected"); } }, ["anthropic"]);
  expect(result.get("anthropic")?.connection).toBe("needs_attention");
});

test("unexpected errors remain visible", async () => {
  await expect(providerAvailability({ getAvailable: async () => { throw new Error("storage failed"); }, checkAuth: async () => ({ type: "api_key" as const }) }, ["anthropic"])).rejects.toThrow("storage failed");
});

test("missing credentials are disconnected rather than needing reconnection", async () => {
  const result = await providerAvailability({ getAvailable: async () => [], checkAuth: async () => undefined }, ["anthropic"]);
  expect(result.get("anthropic")!.connection).toBe("disconnected");
  expect(result.get("anthropic")!.modelIds.size).toBe(0);
});
