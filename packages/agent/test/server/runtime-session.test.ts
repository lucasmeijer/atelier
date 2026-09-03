import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { discardBootstrapOnlySession } from "../../src/server/pi-session.ts";
import { getWorkspaceAgentRuntime, removeWorkspaceAgentRuntime, removeWorkspaceAgentRuntimes } from "../../src/server/runtime.ts";
import { contextUsagePercent, manualCompactionAvailable, terminalCompactionNotice } from "../../src/server/runtime-status.ts";

let dir: string | undefined;

async function sessionFile(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "atelier-runtime-session-test-"));
  return join(dir, "session.jsonl");
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("contextUsagePercent", () => {
  test("uses a compaction estimate until measured usage is available", () => {
    expect(contextUsagePercent(null, 8_000, 128_000)).toBe(6.25);
    expect(contextUsagePercent(undefined, undefined, 128_000)).toBeNull();
    expect(contextUsagePercent(12.5, 8_000, 128_000)).toBe(12.5);
  });
});

test("manual compaction is available only when history exceeds the retained context", () => {
  expect(manualCompactionAvailable(6_001, "message")).toBe(true);
  expect(manualCompactionAvailable(6_000, "message")).toBe(false);
  expect(manualCompactionAvailable(null, "message")).toBe(false);
  expect(manualCompactionAvailable(8_000, "compaction")).toBe(false);
});

test("successful compaction relies on its durable transcript entry instead of a duplicate notice", () => {
  expect(terminalCompactionNotice({})).toBeUndefined();
  expect(terminalCompactionNotice({ aborted: true })).toEqual({ level: "info", message: "Compaction cancelled" });
  expect(terminalCompactionNotice({ errorMessage: "Nothing to compact" })).toEqual({ level: "error", message: "Nothing to compact" });
});

test("removed Workspace runtimes cannot be recreated by stale Agent requests", async () => {
  await removeWorkspaceAgentRuntimes("removed-runtime-test");

  expect(() => getWorkspaceAgentRuntime({ workspaceId: "removed-runtime-test", conversationId: "conversation", label: "Agent 1", title: "Agent", path: "/tmp/removed-session.jsonl" })).toThrow("workspace not found");
});

test("closed conversation runtimes cannot be recreated during the dispose-to-archive gap", async () => {
  const agent = { workspaceId: "closed-runtime-test", conversationId: "53fc77b7-dc19-42d5-b200-2e134ec67529", label: "Agent 1", title: "Agent", path: "/tmp/closed-session.jsonl" };

  await removeWorkspaceAgentRuntime(agent.workspaceId, agent.conversationId);

  expect(() => getWorkspaceAgentRuntime(agent)).toThrow("Agent conversation not found");
});

describe("runtime session persistence", () => {
  test("discards sessions that only contain bootstrap model state", async () => {
    const path = await sessionFile();
    await writeFile(path, [
      JSON.stringify({ type: "model_change", id: "a", parentId: null, provider: "openai", modelId: "gpt" }),
      JSON.stringify({ type: "thinking_level_change", id: "b", parentId: "a", thinkingLevel: "off" }),
      "",
    ].join("\n"));

    await discardBootstrapOnlySession(path);

    expect(await readFile(path, "utf8")).toBe("");
  });

  test("keeps sessions that contain conversation entries", async () => {
    const path = await sessionFile();
    const content = [
      JSON.stringify({ type: "model_change", id: "a", parentId: null, provider: "openai", modelId: "gpt" }),
      JSON.stringify({ type: "message", id: "b", parentId: "a", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      "",
    ].join("\n");
    await writeFile(path, content);

    await discardBootstrapOnlySession(path);

    expect(await readFile(path, "utf8")).toBe(content);
  });

  test("rejects malformed persisted session entry types", async () => {
    const path = await sessionFile();
    const content = `${JSON.stringify({ type: 42 })}\n`;
    await writeFile(path, content);

    await expect(discardBootstrapOnlySession(path)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(content);
  });
});
