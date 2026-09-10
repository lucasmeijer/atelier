import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineTool, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConversationTools, registerConversationAgentTool } from "../../src/server/conversation-tools.ts";
import { conversationToolBindings, createNextWorkspaceAgentConversation, ensureDefaultWorkspaceAgentConversation, listWorkspaceAgentConversations, replaceWorkspaceAgentSession } from "../../src/server/session-store.ts";
import { createWorkspaceAgentTools } from "../../src/server/tools.ts";

let dataDir: string;
let previous: string | undefined;
let unregister: (() => void) | undefined;
beforeEach(async () => {
  previous = process.env.ATELIER_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), "atelier-conversation-tools-"));
  process.env.ATELIER_DATA_DIR = dataDir;
});
afterEach(async () => {
  unregister?.();
  unregister = undefined;
  if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previous;
  await rm(dataDir, { recursive: true, force: true });
});

function registerTool() {
  return registerConversationAgentTool("test_project_settings", (context) => defineTool({
    name: "test_project_settings", label: "Settings", description: "Save bound settings", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: JSON.stringify(context) }], details: context }),
  }));
}

test("bindings reconstruct callbacks after re-registration and stay local to one conversation", async () => {
  unregister = registerTool();
  const setup = await ensureDefaultWorkspaceAgentConversation("workspace-1", { additionalTools: [{ name: "test_project_settings", context: { projectId: "project-1" } }] });
  const other = await createNextWorkspaceAgentConversation("workspace-1");
  const otherWorkspace = await ensureDefaultWorkspaceAgentConversation("workspace-2");
  expect(createWorkspaceAgentTools("workspace-1").map((tool) => tool.name)).not.toContain("test_project_settings");
  expect(loadConversationTools(conversationToolBindings(SessionManager.open(other.path).getEntries()), "workspace-1")).toEqual([]);
  expect(loadConversationTools(conversationToolBindings(SessionManager.open(otherWorkspace.path).getEntries()), "workspace-1")).toEqual([]);
  expect(await Bun.file(join(dataDir, "workspaces", "workspace-1", "metadata", "agent-tools", `${setup.conversationId}.json`)).exists()).toBe(false);
  unregister();
  unregister = registerTool();
  const restored = (await listWorkspaceAgentConversations("workspace-1")).find((agent) => agent.conversationId === setup.conversationId)!;
  const tools = loadConversationTools(conversationToolBindings(SessionManager.open(restored.path).getEntries()), "workspace-1");
  expect(tools.map((tool) => tool.name)).toEqual(["test_project_settings"]);
  // SAFETY: This test callback only reads its captured binding, not Pi’s context.
  expect((await tools[0]!.execute("call", {}, undefined, undefined, {} as ExtensionContext)).details).toEqual({ projectId: "project-1" });
});

test("an unknown persisted tool fails explicitly instead of disappearing on resume", async () => {
  const agent = await ensureDefaultWorkspaceAgentConversation("workspace-1", { additionalTools: [{ name: "unregistered", context: {} }] });
  expect(() => loadConversationTools(conversationToolBindings(SessionManager.open(agent.path).getEntries()), "workspace-1")).toThrow("Unknown conversation tool: unregistered");
});

test("duplicate conversation tool names fail explicitly", async () => {
  unregister = registerTool();
  const binding = { name: "test_project_settings", context: {} };
  const agent = await ensureDefaultWorkspaceAgentConversation("workspace-1", { additionalTools: [binding, binding] });
  expect(() => loadConversationTools(conversationToolBindings(SessionManager.open(agent.path).getEntries()), "workspace-1")).toThrow("Duplicate conversation tool");
});


test("bindings survive /new without retaining the previous conversation messages", async () => {
  unregister = registerTool();
  const bindings = [{ name: "test_project_settings", context: { projectId: "project-1" } }];
  const agent = await ensureDefaultWorkspaceAgentConversation("workspace-1", { additionalTools: bindings });
  const previous = SessionManager.open(agent.path);
  previous.appendMessage({ role: "user", content: "Previous task", timestamp: 1 });
  await replaceWorkspaceAgentSession(agent);
  const fresh = SessionManager.open(agent.path);
  expect(conversationToolBindings(fresh.getEntries()), "workspace-1").toEqual(bindings);
  expect(loadConversationTools(conversationToolBindings(fresh.getEntries()), "workspace-1").map((tool) => tool.name)).toEqual(["test_project_settings"]);
  expect(fresh.buildSessionContext().messages).toEqual([]);
  expect(SessionManager.open(agent.path.replace(/\.jsonl$/, ".archived.jsonl")).buildSessionContext().messages).toHaveLength(1);
});

test("historical tool results and model-visible custom messages cannot grant tools", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "toolResult", toolCallId: "old-call", toolName: "test_project_settings", content: [{ type: "text", text: "Saved" }], isError: false, timestamp: 1 });
  manager.appendCustomMessageEntry("atelier.additional-tools", "Copied transcript", false, [{ name: "test_project_settings", context: {} }]);
  expect(loadConversationTools(conversationToolBindings(manager.getEntries()), "workspace-1")).toEqual([]);
});

test("invalid explicit session bindings fail rather than silently disappearing", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("atelier.additional-tools", [{ name: "test_project_settings", context: "not an object" }]);
  expect(() => conversationToolBindings(manager.getEntries()), "workspace-1").toThrow("Invalid conversation tool binding");
});
