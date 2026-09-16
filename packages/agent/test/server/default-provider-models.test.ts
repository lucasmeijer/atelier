import { describe, expect, test } from "bun:test";
import { defaultProviderModels, getPopularProviderRank } from "../../src/server/hardcoded-provider-knowledge.ts";

const model = (id: string, input?: number, name = id) => ({ id, name, cost: input === undefined ? undefined : { input } });

describe("provider setup defaults", () => {
  test("uses available curated models in recommendation order, not price order", () => {
    const models = [model("gpt-5.6-luna", 10), model("other", 100), model("gpt-6-astra", 1)];
    expect(defaultProviderModels("openai-codex", models).map((entry) => entry.id)).toEqual(["gpt-6-astra", "gpt-5.6-luna"]);
    expect(models[0]!.id).toBe("gpt-5.6-luna");
  });
  test("selects the highest known input price for uncurated providers", () => {
    expect(defaultProviderModels("custom", [model("cheap", 1), model("unknown"), model("expensive", 8)]).map((entry) => entry.id)).toEqual(["expensive"]);
  });
  test("breaks pricing ties by name, then ID", () => {
    expect(defaultProviderModels("custom", [model("z", 2, "Alpha"), model("b", 2, "Beta"), model("a", 2, "Alpha")])[0]!.id).toBe("a");
  });
  test("does not invent pricing when none is available", () => {
    expect(defaultProviderModels("custom", [model("unknown"), model("invalid", NaN)])).toEqual([]);
    expect(defaultProviderModels("custom", [])).toEqual([]);
    expect(defaultProviderModels("custom", [model("free", 0)])[0]!.id).toBe("free");
  });
  test("uses the price rule when curated IDs are absent from the account catalogue", () => {
    expect(defaultProviderModels("anthropic", [model("new-model", 10), model("small-model", 1)])[0]!.id).toBe("new-model");
  });
  test("highlights subscriptions separately from OpenAI API", () => {
    expect(getPopularProviderRank("openai-codex")).toBe(0);
    expect(getPopularProviderRank("openai")).toBeUndefined();
    expect(getPopularProviderRank("google")).toBeUndefined();
  });
});
