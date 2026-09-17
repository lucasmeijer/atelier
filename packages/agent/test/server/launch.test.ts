import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAgentLaunch, nativeAgentLaunch } from "../../src/server/launch.ts";
import { listWorkspaceAgentConversations } from "../../src/server/session-store.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atelier-agent-launch-"));
  process.env.ATELIER_DATA_DIR = directory;
});
afterEach(async () => {
  delete process.env.ATELIER_DATA_DIR;
  await rm(directory, { recursive: true, force: true });
});

test("empty launch settings do not introduce an agent task", async () => {
  expect(await prepareAgentLaunch()).toBeUndefined();
  expect(await prepareAgentLaunch({ initialPrompt: "   " })).toBeUndefined();
});

test("agent launch owns validation of its parameters", async () => {
  await expect(prepareAgentLaunch({ model: 42 })).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(prepareAgentLaunch({ thinkingLevel: [] })).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(prepareAgentLaunch({ initialPromptMode: "run-anything" })).rejects.toMatchObject({ code: "invalid_arguments" });
});

test("explicit composer drafts preserve native settings without starting inference", async () => {
  expect(await prepareAgentLaunch({
    initialPrompt: "  Investigate later  ", initialPromptMode: "composer",
    model: "openai::gpt-5.4", thinkingLevel: "high", serviceTier: "priority", attachmentDraft: "draft-1",
  })).toEqual({ agent: {
    initialPrompt: "Investigate later", initialPromptMode: "composer",
    model: "openai::gpt-5.4", thinkingLevel: "high", serviceTier: "priority", attachmentDraft: "draft-1",
  } });
});

test("host-requested preparation retains the existing native session identity", async () => {
  await nativeAgentLaunch.prepareWorkspace("launch-workspace");
  const first = await listWorkspaceAgentConversations("launch-workspace");
  await nativeAgentLaunch.prepareWorkspace("launch-workspace");
  expect(await listWorkspaceAgentConversations("launch-workspace")).toEqual(first);
  expect(first).toHaveLength(1);
});
