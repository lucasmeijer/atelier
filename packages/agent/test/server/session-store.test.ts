import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createNextWorkspaceAgent,
  ensureDefaultWorkspaceAgent,
  listWorkspaceAgents,
  parseWorkspaceAgentFilename,
  workspaceAgentSessionPath,
} from "../../src/server/session-store.ts";

let dir: string | undefined;

async function dataDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "atelier-agent-test-"));
  process.env.ATELIER_DATA_DIR = dir;
  return dir;
}

afterEach(async () => {
  delete process.env.ATELIER_DATA_DIR;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("workspace agent session store", () => {
  test("parses and ignores filenames", () => {
    expect(parseWorkspaceAgentFilename("Agent 1.jsonl")).toEqual({ label: "Agent 1", number: 1 });
    expect(parseWorkspaceAgentFilename("Agent 0.jsonl")).toBeUndefined();
    expect(parseWorkspaceAgentFilename("Agent x.jsonl")).toBeUndefined();
  });

  test("ensureDefaultWorkspaceAgent creates Agent 1.jsonl", async () => {
    const root = await dataDir();
    const agent = await ensureDefaultWorkspaceAgent("ws1");
    expect(agent.label).toBe("Agent 1");
    expect(agent.path).toBe(join(root, "workspace-agents", "ws1", "Agent 1.jsonl"));
    expect(await Bun.file(agent.path).exists()).toBe(true);
  });

  test("createNextWorkspaceAgent creates lowest unused agent number and list sorts", async () => {
    await dataDir();
    await ensureDefaultWorkspaceAgent("ws1");
    await writeFile(workspaceAgentSessionPath("ws1", "Agent 10"), "");
    await writeFile(join(process.env.ATELIER_DATA_DIR!, "workspace-agents", "ws1", "notes.txt"), "ignored");
    const next = await createNextWorkspaceAgent("ws1");
    expect(next.label).toBe("Agent 2");
    const agents = await listWorkspaceAgents("ws1");
    expect(agents.map((agent) => agent.label)).toEqual(["Agent 1", "Agent 2", "Agent 10"]);
  });
});
