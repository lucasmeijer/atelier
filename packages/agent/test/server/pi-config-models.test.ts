import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCustomModelsJson, setCustomModelsJson } from "../../src/server/pi-config-models.ts";

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
