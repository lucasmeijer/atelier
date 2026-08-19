import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { createWorkspacePresentationStore } from "@atelier/workspace";
import {
  archiveWorkspaceAgentConversation,
  createNextWorkspaceAgent,
  ensureDefaultWorkspaceAgent,
  listWorkspaceAgents,
  parseWorkspaceAgentFilename,
  replaceWorkspaceAgentSession,
  setWorkspaceAgentConversationTitle,
  sessionShareDir,
  sessionShareKeySlug,
  sessionTopicSlug,
  workspaceAgentConversationContributions,
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
    expect(parseWorkspaceAgentFilename("fix-auth-flow--ws1--agent-2--53fc77b7-dc19-42d5-b200-2e134ec67529.jsonl", "ws1")).toEqual({
      conversationId: "53fc77b7-dc19-42d5-b200-2e134ec67529",
      label: "Agent 2",
      number: 2,
    });
    expect(parseWorkspaceAgentFilename("fix-auth-flow--ws1--agent-2--53fc77b7-dc19-42d5-b200-2e134ec67529.jsonl", "ws2")).toBeUndefined();
  });

  test("projectless workspace agents live in the projectless session share", async () => {
    const root = await dataDir();
    const agent = await ensureDefaultWorkspaceAgent("ws1", { topic: "Scratch bug hunt" });
    expect(agent.label).toBe("Agent 1");
    expect(agent.conversationId).toMatch(/^[0-9a-f-]{36}$/);
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

  test("ignores incomplete persisted project metadata", async () => {
    const root = await dataDir();
    const path = join(root, "workspaces", "ws1", "metadata");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "init.json"), JSON.stringify({ type: "project.git", sessionShareKey: "unvalidated-share" }));

    const agent = await ensureDefaultWorkspaceAgent("ws1");

    expect(agent.path).toStartWith(join(root, "session-shares", "projectless"));
  });

  test("workspaces with the same session share key share storage while Agent conversations stay Workspace-local", async () => {
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
    const oldAgentPath = join(root, "session-shares", "projectless", "old-task--ws1--agent-10--268604ac-d16a-4a4a-ab1e-1ed3ca54687d.jsonl");
    await writeFile(oldAgentPath, "");
    await writeFile(oldAgentPath.replace(/\.jsonl$/, ".title"), "Old task\n");
    await writeFile(join(root, "session-shares", "projectless", "notes.txt"), "ignored");
    const next = await createNextWorkspaceAgent("ws1");
    expect(next.label).toBe("Agent 2");
    const agents = await listWorkspaceAgents("ws1");
    expect(agents.map((agent) => agent.label)).toEqual(["Agent 1", "Agent 2", "Agent 10"]);
  });

  test("migrates legacy short-id sessions to titled immutable conversations", async () => {
    const root = await dataDir();
    const share = join(root, "session-shares", "projectless");
    await mkdir(share, { recursive: true });
    const legacyPath = join(share, "investigate-persistence--ws1--agent-1--a1b2c3.jsonl");
    await writeFile(legacyPath, '{"type":"message"}\n');

    const [firstListing, secondListing] = await Promise.all([listWorkspaceAgents("ws1"), listWorkspaceAgents("ws1")]);
    const [agent] = firstListing;

    expect(secondListing).toEqual(firstListing);
    expect(agent).toMatchObject({ label: "Agent 1", title: "Investigate persistence" });
    expect(agent!.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await Bun.file(agent!.path).text()).toBe('{"type":"message"}\n');
    expect(await Bun.file(agent!.path.replace(/\.jsonl$/, ".title")).text()).toBe("Investigate persistence\n");
    expect(await Bun.file(legacyPath).exists()).toBe(false);
  });

  test("preserves new sessions while renumbering recovered legacy label collisions", async () => {
    const root = await dataDir();
    const current = await ensureDefaultWorkspaceAgent("ws1");
    await writeFile(current.path, '{"type":"current"}\n');
    const share = join(root, "session-shares", "projectless");
    await writeFile(join(share, "agent-session--ws1--agent-1--a1b2c3.jsonl"), '{"type":"legacy-one"}\n');
    await writeFile(join(share, "older-work--ws1--agent-2--d4e5f6.jsonl"), '{"type":"legacy-two"}\n');

    const agents = await listWorkspaceAgents("ws1");

    expect(agents.map((agent) => [agent.label, agent.title])).toEqual([
      ["Agent 1", "Untitled"],
      ["Agent 2", "Recovered Agent 1"],
      ["Agent 3", "Older work"],
    ]);
    expect(await Promise.all(agents.map((agent) => Bun.file(agent.path).text()))).toEqual([
      '{"type":"current"}\n',
      '{"type":"legacy-one"}\n',
      '{"type":"legacy-two"}\n',
    ]);
  });

  test("Agent conversations have immutable identities and mutable titles", async () => {
    await dataDir();
    const created = await ensureDefaultWorkspaceAgent("ws1");
    expect(created.title).toBe("Untitled");

    const renamed = await setWorkspaceAgentConversationTitle(created, "Investigate persistence");

    expect(renamed).toMatchObject({ conversationId: created.conversationId, title: "Investigate persistence" });
    expect(await listWorkspaceAgents("ws1")).toEqual([renamed]);
  });

  test("archiving an Agent conversation retains its transcript and title as history", async () => {
    await dataDir();
    const first = await ensureDefaultWorkspaceAgent("ws1");
    const second = await createNextWorkspaceAgent("ws1");
    await writeFile(second.path, '{"type":"message"}\n');

    await archiveWorkspaceAgentConversation(second);

    expect(await listWorkspaceAgents("ws1")).toEqual([first]);
    expect(await Bun.file(second.path.replace(/\.jsonl$/, ".archived.jsonl")).text()).toBe('{"type":"message"}\n');
    expect(await Bun.file(second.path.replace(/\.jsonl$/, ".archived.title")).text()).toBe("Untitled\n");
  });

  test("Agent conversation contributions integrate archive-on-close with Workspace presentation", async () => {
    const root = await dataDir();
    const first = await ensureDefaultWorkspaceAgent("ws1");
    const second = await createNextWorkspaceAgent("ws1");
    const presentation = createWorkspacePresentationStore({
      dataDir: root,
      workViewContributions: [],
      agentConversations: workspaceAgentConversationContributions,
    });

    await presentation.closeAgentConversation("ws1", second.conversationId);

    expect(await presentation.listAgentConversations("ws1")).toEqual([{ id: first.conversationId, title: "Untitled" }]);
  });

  test("replaces the session behind an existing agent tab and archives the old session", async () => {
    await dataDir();
    const original = await ensureDefaultWorkspaceAgent("ws1");
    await writeFile(original.path, '{"type":"message"}\n');

    const replacement = await replaceWorkspaceAgentSession(original);

    expect(replacement.label).toBe(original.label);
    expect(replacement.conversationId).toBe(original.conversationId);
    expect(replacement.path).toBe(original.path);
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
