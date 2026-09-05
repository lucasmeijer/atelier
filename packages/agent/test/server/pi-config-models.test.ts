import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfiguredAgentModels, getCustomModelsJson, getLastProviderServiceTier, getModelThinkingLevel, setActiveAgentModel, setCustomModelsJson, setLastProviderServiceTier, setModelThinkingLevel, setPickerAgentModels } from "../../src/server/pi-config-models.ts";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-custom-models-"));
  process.env.ATELIER_DATA_DIR = dataDir;
});

afterEach(async () => {
  delete process.env.ATELIER_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

describe("custom Pi model configuration", () => {
  test("rejects malformed JSON and invalid Pi model definitions without replacing saved configuration", async () => {
    const valid = JSON.stringify({ providers: { "openai-codex": { models: [{ id: "future-model" }] } } });
    await setCustomModelsJson(valid);

    expect(setCustomModelsJson("{ broken")).rejects.toThrow("Invalid JSON");
    expect(setCustomModelsJson(JSON.stringify({ providers: { "openai-codex": { models: [{ id: 42 }] } } }))).rejects.toThrow("must be string");
    expect(JSON.parse(await getCustomModelsJson())).toEqual(JSON.parse(valid));
  });

  test("retains pasted definitions but omits models supplied by the official catalogue", async () => {
    const source = JSON.stringify({
      providers: {
        "openai-codex": {
          models: [
            { id: "gpt-5.4", name: "Stale custom copy" },
            { id: "future-model", name: "Future model" },
          ],
        },
      },
    });

    const result = await setCustomModelsJson(source);
    const effective = JSON.parse(await readFile(join(dataDir, "pi-config", "models.json"), "utf8"));

    expect(result.skippedOfficialModels).toEqual([{ provider: "openai-codex", id: "gpt-5.4" }]);
    expect(effective.providers["openai-codex"].models).toEqual([{ id: "future-model", name: "Future model" }]);
    expect(JSON.parse(await getCustomModelsJson()).providers["openai-codex"].models).toHaveLength(2);
  });
});

describe("Agent model settings transactions", () => {
  test("concurrent preference and picker updates preserve each other", async () => {
    await Promise.all([
      setPickerAgentModels([{ provider: "openai-codex", id: "gpt-5.4", label: "My model" }]),
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
