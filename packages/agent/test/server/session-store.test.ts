import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createNextWorkspaceAgent,
  ensureDefaultWorkspaceAgent,
  listWorkspaceAgents,
  parseWorkspaceAgentFilename,
  replaceWorkspaceAgentSession,
  sessionShareDir,
  sessionShareKeySlug,
  sessionTopicSlug,
} from "../../src/server/session-store.ts";

let dir: string | undefined;

async function dataDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "atelier-agent-test-"));
  process.env.ATELIER_DATA_DIR = dir;
  return dir;
}

async function writeProjectInit(workspaceId: string, projectId: string, sessionShareKey: string): Promise<void> {
  const path = join(process.env.ATELIER_DATA_DIR!, "workspaces", workspaceId, "metadata");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "init.json"), JSON.stringify({ type: "project.git", projectId, name: "repo", gitUrl: "https://example.com/repo.git", branch: null, sessionShareKey }));
}

afterEach(async () => {
  delete process.env.ATELIER_DATA_DIR;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("workspace agent session store", () => {
  test("parses and ignores filenames", () => {
    expect(parseWorkspaceAgentFilename("Agent 1.jsonl")).toBeUndefined();
    expect(parseWorkspaceAgentFilename("fix-auth-flow--ws1--agent-2--a1b2c3.jsonl", "ws1")).toEqual({ label: "Agent 2", number: 2 });
    expect(parseWorkspaceAgentFilename("fix-auth-flow--ws1--agent-2--a1b2c3.jsonl", "ws2")).toBeUndefined();
  });

  test("projectless workspace agents live in the projectless session share", async () => {
    const root = await dataDir();
    const agent = await ensureDefaultWorkspaceAgent("ws1", { topic: "Scratch bug hunt" });
    expect(agent.label).toBe("Agent 1");
    expect(agent.path).toStartWith(join(root, "session-shares", "projectless", "scratch-bug-hunt--ws1--agent-1--"));
    expect(agent.path).toEndWith(".jsonl");
    expect(await Bun.file(agent.path).exists()).toBe(true);
  });

  test("project workspace agents live in the project's session share with topic filenames", async () => {
    const root = await dataDir();
    await writeProjectInit("ws1", "repo-1234", "Product Suite");
    const agent = await ensureDefaultWorkspaceAgent("ws1", { topic: "Add OAuth refresh flow!!" });
    expect(agent.label).toBe("Agent 1");
    expect(agent.path).toStartWith(join(root, "session-shares", "product-suite", "add-oauth-refresh-flow--ws1--agent-1--"));
    expect(agent.path).toEndWith(".jsonl");
    expect(await Bun.file(agent.path).exists()).toBe(true);
  });

  test("workspaces with the same session share key share storage while tabs stay workspace-local", async () => {
    await dataDir();
    await writeProjectInit("front", "frontend", "suite");
    await writeProjectInit("back", "backend", "suite");
    await ensureDefaultWorkspaceAgent("front", { topic: "frontend work" });
    await ensureDefaultWorkspaceAgent("back", { topic: "backend work" });
    expect((await listWorkspaceAgents("front")).map((agent) => agent.path.split("/").at(-1))).toEqual([expect.stringContaining("frontend-work--front--agent-1--")]);
    expect((await listWorkspaceAgents("back")).map((agent) => agent.path.split("/").at(-1))).toEqual([expect.stringContaining("backend-work--back--agent-1--")]);
  });

  test("createNextWorkspaceAgent creates lowest unused agent number and list sorts", async () => {
    const root = await dataDir();
    await ensureDefaultWorkspaceAgent("ws1");
    await writeFile(join(root, "session-shares", "projectless", "old-task--ws1--agent-10--abcdef.jsonl"), "");
    await writeFile(join(root, "session-shares", "projectless", "notes.txt"), "ignored");
    const next = await createNextWorkspaceAgent("ws1");
    expect(next.label).toBe("Agent 2");
    const agents = await listWorkspaceAgents("ws1");
    expect(agents.map((agent) => agent.label)).toEqual(["Agent 1", "Agent 2", "Agent 10"]);
  });

  test("replaces the session behind an existing agent tab and archives the old session", async () => {
    await dataDir();
    const original = await ensureDefaultWorkspaceAgent("ws1");
    await writeFile(original.path, '{"type":"message"}\n');

    const replacement = await replaceWorkspaceAgentSession(original);

    expect(replacement.label).toBe(original.label);
    expect(replacement.path).not.toBe(original.path);
    expect(await Bun.file(replacement.path).text()).toBe("");
    expect(await Bun.file(original.path.replace(/\.jsonl$/, ".archived.jsonl")).text()).toBe('{"type":"message"}\n');
    expect(await listWorkspaceAgents("ws1")).toEqual([replacement]);
  });

  test("slugs are filesystem friendly", () => {
    expect(sessionTopicSlug("Add OAuth refresh flow!!")).toBe("add-oauth-refresh-flow");
    expect(sessionTopicSlug("!!!")).toBe("agent-session");
    expect(sessionShareKeySlug("Product Suite")).toBe("product-suite");
    expect(sessionShareDir("Product Suite", "/tmp/data")).toBe("/tmp/data/session-shares/product-suite");
  });
});
