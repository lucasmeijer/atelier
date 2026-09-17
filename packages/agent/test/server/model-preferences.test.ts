import { updateJsonSettings } from "@atelier/core/json-settings";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiModelRuntime, disconnectModelProvider, seedProviderFavoriteModels, getCustomModelsJson, setCustomModelsJson, setConfiguredModels } from "@atelier/llm/server";
import { reconcileAgentModelPreferences, getConfiguredAgentModels, getLastProviderServiceTier, getModelThinkingLevel, setActiveAgentModel, setLastProviderServiceTier, setModelThinkingLevel } from "../../src/server/model-preferences.ts";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-custom-models-"));
  process.env.ATELIER_DATA_DIR = dataDir;
});

afterEach(async () => {
  delete process.env.ATELIER_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

describe("Agent model settings transactions", () => {
  test("concurrent preference and picker updates preserve each other", async () => {
    await Promise.all([
      setConfiguredModels([{ provider: "openai-codex", id: "gpt-5.4", label: "My model" }]),
      setActiveAgentModel("openai-codex", "gpt-5.4", "high"),
      setModelThinkingLevel("anthropic", "claude", "medium"),
      setLastProviderServiceTier("openai-codex", "priority"),
    ]);

    expect(await getConfiguredAgentModels()).toEqual([{ provider: "openai-codex", id: "gpt-5.4", label: "My model", active: true }]);
    expect(await getModelThinkingLevel("openai-codex", "gpt-5.4")).toBe("high");
    expect(await getModelThinkingLevel("anthropic", "claude")).toBe("medium");
    expect(await getLastProviderServiceTier("openai-codex")).toBe("priority");
  });

  test("custom model materialization preserves concurrent preferences", async () => {
    await Promise.all([
      setCustomModelsJson(JSON.stringify({ providers: { "openai-codex": { models: [{ id: "future-model" }] } } })),
      ...Array.from({ length: 8 }, (_, index) => setModelThinkingLevel("openai-codex", `model-${index}`, "high")),
    ]);

    for (let index = 0; index < 8; index++) expect(await getModelThinkingLevel("openai-codex", `model-${index}`)).toBe("high");
    expect(JSON.parse(await getCustomModelsJson()).providers["openai-codex"].models).toEqual([{ id: "future-model" }]);
  });
});


test("connecting seeds defaults once, preserves other selections, and disconnect removes only that provider", async () => {
  const runtime = await createPiModelRuntime();
  await runtime.login("openai", "api_key", { prompt: async () => "test-only-key", notify: () => {} });
  await seedProviderFavoriteModels("openai");
  const first = await getConfiguredAgentModels();
  expect(first.length).toBeGreaterThan(0);
  expect(first[0]!.active).toBe(true);

  const retained = { provider: "openai", id: "gpt-5.4", label: "My selection", active: true };
  await setConfiguredModels([retained]);
  await seedProviderFavoriteModels("openai");
  expect(await getConfiguredAgentModels()).toEqual([retained]);

  await runtime.login("anthropic", "api_key", { prompt: async () => "test-only-key", notify: () => {} });
  await seedProviderFavoriteModels("anthropic");
  const both = await getConfiguredAgentModels();
  expect(both.find((model) => model.active)?.provider).toBe("openai");
  expect(both.some((model) => model.provider === "anthropic")).toBe(true);

  await disconnectModelProvider("openai");
  expect(runtime.getProviderAuthStatus("openai").configured).toBe(false);
  expect((await getConfiguredAgentModels()).every((model) => model.provider === "anthropic")).toBe(true);
  expect((await getConfiguredAgentModels())[0]!.active).toBe(true);

  await disconnectModelProvider("anthropic");
  expect(await getConfiguredAgentModels()).toEqual([]);
});


test("catalogue changes forget a removed native default without losing thinking preferences", async () => {
  const first = { provider: "openai", id: "first", label: "First" };
  const second = { provider: "openai", id: "second", label: "Second" };
  await setConfiguredModels([first, second]);
  await setActiveAgentModel(first.provider, first.id, "high");
  await setConfiguredModels([second]);
  await reconcileAgentModelPreferences();
  await setConfiguredModels([first, second]);
  expect((await getConfiguredAgentModels()).find((model) => model.active)?.id).toBe("second");
  expect(await getModelThinkingLevel(first.provider, first.id)).toBe("high");
  await setConfiguredModels([]);
  await reconcileAgentModelPreferences();
  expect(JSON.parse(await readFile(join(dataDir, "pi-config", "models.json"), "utf8")).activeModel).toBeUndefined();
});


test("reads individual legacy preferences and preserves unrelated persisted fields", async () => {
  const path = join(dataDir, "pi-config", "models.json");
  await updateJsonSettings(path, (stored) => {
    stored.modelPreferences = {
      "openai::valid": { thinkingLevel: "high", retained: true },
      "openai::invalid": { thinkingLevel: 42 },
    };
    stored.providerPreferences = { valid: { serviceTier: "priority", retained: true }, legacy: { serviceTier: "unknown" }, invalid: 42 };
    stored.otherOwner = { retained: true };
  });
  expect(await getModelThinkingLevel("openai", "valid")).toBe("high");
  expect(await getModelThinkingLevel("openai", "invalid")).toBeUndefined();
  expect(await getModelThinkingLevel("openai", "missing")).toBeUndefined();
  expect(await getLastProviderServiceTier("valid")).toBe("priority");
  expect(await getLastProviderServiceTier("legacy")).toBe("default");
  expect(await getLastProviderServiceTier("invalid")).toBeUndefined();
  await setModelThinkingLevel("openai", "valid", "medium");
  await setLastProviderServiceTier("valid", "default");
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.modelPreferences["openai::valid"]).toEqual({ thinkingLevel: "medium", retained: true });
  expect(saved.providerPreferences.valid).toEqual({ serviceTier: "default", retained: true });
  expect(saved.otherOwner).toEqual({ retained: true });
});
