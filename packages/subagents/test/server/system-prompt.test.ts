import { expect, test } from "bun:test";
import { delegationPolicy } from "../../src/server/prompt.ts";

test("delegation instructions require explicit user authorization, including recursive delegation", () => {
  expect(delegationPolicy).toContain("Use subagents only when the user explicitly asks you to use subagents or delegate work to other agents.");
  expect(delegationPolicy).toContain("do not spawn subagents or assign them follow-up tasks just because parallel execution could help.");
  expect(delegationPolicy).toContain("This restriction also applies to further delegation by subagents.");
});
