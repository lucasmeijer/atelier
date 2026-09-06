import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSubagentHistory, preserveLegacySubagentHistories, subagentHistoryDirectory, subagentHistoryRelativeDirectory } from "../../src/server/history-store.ts";

let dataDir: string;
afterEach(async () => { if (dataDir) await rm(dataDir, { recursive: true, force: true }); });
async function setup() {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-subagent-history-"));
  return dataDir;
}
async function project(workspaceId: string, shareKey: string) {
  const directory = join(dataDir, "workspaces", workspaceId, "metadata");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "init.json"), JSON.stringify({ type: "project.git", projectId: "project", name: "Example", gitUrl: "https://example.com/repo.git", branch: null, sessionShareKey: shareKey }));
}

test("child sessions use the same project share as root sessions, not workspace-private storage", async () => {
  await setup();
  await project("workspace", "Team Repo");
  const directory = await openSubagentHistory("workspace", dataDir);
  expect(directory).toBe(join(dataDir, "session-shares", "team-repo", "subagents", "workspace"));
  expect(await subagentHistoryDirectory("workspace", dataDir)).toBe(directory);
  expect(subagentHistoryRelativeDirectory("workspace")).toBe("subagents/workspace");
  expect(existsSync(join(dataDir, "session-shares", "team-repo", "SUBAGENTS.md"))).toBe(true);
});

test("projectless histories share the existing projectless mount and remain workspace-scoped", async () => {
  await setup();
  const a = await openSubagentHistory("a", dataDir);
  const b = await openSubagentHistory("b", dataDir);
  expect(a).toBe(join(dataDir, "session-shares", "projectless", "subagents", "a"));
  expect(b).toBe(join(dataDir, "session-shares", "projectless", "subagents", "b"));
});

test("old histories relocate intact, including closed children and arbitrary existing session entries", async () => {
  await setup();
  await project("old", "repo");
  const legacy = join(dataDir, "workspaces", "old", "subagents");
  await mkdir(legacy, { recursive: true });
  const ledger = JSON.stringify({ agents: [{ id: "child", rootId: "root", parentId: "root", taskName: "review", status: "closed" }], messages: [] });
  const session = '{"type":"custom","customType":"subagent-model-delivery","data":{"preserve":"exact bytes"}}\n';
  await writeFile(join(legacy, "state.json"), ledger);
  await writeFile(join(legacy, "child.jsonl"), session);
  const directory = await openSubagentHistory("old", dataDir);
  expect(existsSync(legacy)).toBe(false);
  expect(await readFile(join(directory, "state.json"), "utf8")).toBe(ledger);
  expect(await readFile(join(directory, "child.jsonl"), "utf8")).toBe(session);
  expect(await openSubagentHistory("old", dataDir)).toBe(directory);
  expect(await readFile(join(directory, "child.jsonl"), "utf8")).toBe(session);
});

test("startup preserves unopened legacy workspaces before they can be deleted", async () => {
  await setup();
  await project("inactive", "repo");
  const legacy = join(dataDir, "workspaces", "inactive", "subagents");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "child.jsonl"), "saved history\n");
  await preserveLegacySubagentHistories(dataDir);
  await rm(join(dataDir, "workspaces", "inactive"), { recursive: true });
  expect(await readFile(join(dataDir, "session-shares", "repo", "subagents", "inactive", "child.jsonl"), "utf8")).toBe("saved history\n");
});

test("a historical root resolves its descendants using only files inside its share, after archival and deletion", async () => {
  await setup();
  await project("workspace", "repo");
  const directory = await openSubagentHistory("workspace", dataDir);
  const share = join(directory, "..", "..");
  const rootId = "50ccf2f0-4bb4-47f3-b84a-8d9a13b9bb9e";
  const root = join(share, `history--workspace--agent-1--${rootId}.jsonl`);
  await writeFile(root, JSON.stringify({ type: "custom", customType: "subagent_history", data: { rootId, directory: subagentHistoryRelativeDirectory("workspace"), ledger: "state.json" } }) + "\n");
  const agents = [
    { id: "child", rootId, parentId: rootId, taskName: "review" },
    { id: "grandchild", rootId, parentId: "child", taskName: "check" },
    { id: "unrelated", rootId: "another-root", parentId: "another-root", taskName: "review" },
  ];
  await writeFile(join(directory, "state.json"), JSON.stringify({ agents, messages: [] }));
  for (const agent of agents) await writeFile(join(directory, `${agent.id}.jsonl`), `${agent.id} history\n`);
  await rename(root, root.replace(".jsonl", ".archived.jsonl"));
  await rm(join(dataDir, "workspaces", "workspace"), { recursive: true });
  const reference = JSON.parse(await readFile(root.replace(".jsonl", ".archived.jsonl"), "utf8")).data;
  const ledger = JSON.parse(await readFile(join(share, reference.directory, reference.ledger), "utf8"));
  const descendants = ledger.agents.filter((agent: { rootId: string }) => agent.rootId === reference.rootId);
  expect(descendants.map((agent: { id: string }) => agent.id)).toEqual(["child", "grandchild"]);
  for (const agent of descendants) expect(await readFile(join(share, reference.directory, `${agent.id}.jsonl`), "utf8")).toBe(`${agent.id} history\n`);
});

test("conflicting legacy and shared histories fail visibly rather than losing either tree", async () => {
  await setup();
  const shared = await openSubagentHistory("collision", dataDir);
  const legacy = join(dataDir, "workspaces", "collision", "subagents");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(shared, "state.json"), "shared");
  await writeFile(join(legacy, "state.json"), "legacy");
  await expect(openSubagentHistory("collision", dataDir)).rejects.toThrow("Both legacy and shared");
  expect(await readFile(join(shared, "state.json"), "utf8")).toBe("shared");
  expect(await readFile(join(legacy, "state.json"), "utf8")).toBe("legacy");
});

test("root preparation writes a discoverable reference once and child resolution uses that shared directory", async () => {
  await setup();
  await project("reference", "repo");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { subagentsDelegation } = await import("../../src/server/delegation.ts");
  const { shutdownSubagents, subagentConversation } = await import("../../src/server/subagents.ts");
  const previous = process.env.ATELIER_DATA_DIR;
  process.env.ATELIER_DATA_DIR = dataDir;
  try {
    const preparation = await subagentsDelegation.prepare({ agent: { workspaceId: "reference", conversationId: "root", label: "Agent 1", title: "History", path: join(dataDir, "session-shares", "repo", "root.jsonl") } });
    const manager = SessionManager.inMemory();
    preparation.seedHistory!(manager);
    preparation.seedHistory!(manager);
    const branch = manager.getBranch();
    expect(branch).toHaveLength(1);
    expect(branch[0]).toMatchObject({ type: "custom", customType: "subagent_history", data: { rootId: "root", directory: "subagents/reference", ledger: "state.json", guide: "SUBAGENTS.md" } });
    const child = await subagentConversation("reference", { id: "child", parentId: "root", rootId: "root", taskName: "review", task: "Review", depth: 1, status: "completed", thinkingLevel: "off" });
    expect(child.path).toBe(join(dataDir, "session-shares", "repo", "subagents", "reference", "child.jsonl"));
  } finally {
    await shutdownSubagents("reference");
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previous;
  }
});
