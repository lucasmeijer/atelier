import { expect, test } from "bun:test";
import { atelierSystemPrompt, createAtelierResourceLoader } from "../../src/server/system-prompt.ts";

test("the shared model prompt requires explicit user authorization for delegation", () => {
  const loader = createAtelierResourceLoader();
  expect(loader.getSystemPrompt()).toBe(atelierSystemPrompt);
  expect(atelierSystemPrompt).toContain("Use subagents only when the user explicitly asks you to use subagents or delegate work to other agents.");
  expect(atelierSystemPrompt).toContain("do not spawn subagents or assign them follow-up tasks just because parallel execution could help.");
  expect(atelierSystemPrompt).toContain("This restriction also applies to further delegation by subagents.");
});

test("workspace and child-agent context supplement rather than replace the shared policy", () => {
  const context = ["Your canonical task name is /root/reviewer. Your parent is /root."];
  const loader = createAtelierResourceLoader([{ path: "/work/AGENTS.md", content: "Project instructions" }], context);
  expect(loader.getSystemPrompt()).toBe(atelierSystemPrompt);
  expect(loader.getAppendSystemPrompt()).toEqual(context);
});
