import { expect, test } from "bun:test";
import { codexModelId } from "../../src/server/codex-model.ts";
import { delegationPrompt } from "../../src/server/prompt.ts";
import upstream from "../../src/server/codex-prompts.json";

test("every exact Codex identifier takes precedence over broader family matches", () => {
  for (const id of Object.keys(upstream.models)) expect(codexModelId(id)).toBe(id);
});

test("provider and regional identifiers and variants resolve for Astra and Sol", () => {
  for (const id of ["gpt-6-astra", "gpt-5.6-sol"]) {
    for (const prefix of ["", "openai/", "openai.", "global.openai.", "us.openai."]) {
      for (const suffix of ["", "-pro", "-fast", ":batch", "-pro:batch"]) {
        const variant = `${prefix}${id}${suffix}`;
        expect(codexModelId(variant)).toBe(id);
        for (const role of ["root", "subagent"] as const) {
          expect(delegationPrompt(variant, "medium", role)).toEqual(delegationPrompt(id, "medium", role));
        }
      }
    }
  }
});

test("named families require both GPT and the family name, regardless of case or order", () => {
  for (const [name, id] of [["astra", "gpt-6-astra"], ["sol", "gpt-5.6-sol"], ["terra", "gpt-5.6-terra"], ["luna", "gpt-5.6-luna"]]) {
    expect(codexModelId(`provider/${name!.toUpperCase()}-GPT-fast`)).toBe(id);
    expect(codexModelId(`provider/${name}`)).toBeUndefined();
  }
  for (const id of [undefined, "", "gpt", "custom-astra", "claude-sol"]) expect(codexModelId(id)).toBeUndefined();
});

test("contained exact identifiers win over family hints and support other catalogue models", () => {
  expect(codexModelId("sol/openai/gpt-6-astra")).toBe("gpt-6-astra");
  expect(codexModelId("openai/gpt-5.4-mini:batch")).toBe("gpt-5.4-mini");
  expect(codexModelId("openai/gpt-daybreak-blue-latest")).toBe("gpt-daybreak-blue-latest");
});
