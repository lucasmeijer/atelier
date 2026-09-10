import { describe, expect, test } from "bun:test";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { inheritedContextEntryType, selectForkHistory } from "../../src/server/fork-history.ts";
import { bindSubagentSession, forkSubagentHistory } from "../../src/server/subagents.ts";
import { SubagentRuntime } from "../../src/server/subagent-runtime.ts";

type Message = AgentSession["messages"][number];
const user = (text: string): Extract<Message, { role: "user" }> => ({ role: "user", content: text, timestamp: 1 });
const text = (value: string, phase?: "commentary" | "final_answer"): TextContent => ({ type: "text", text: value, textSignature: phase ? JSON.stringify({ v: 1, phase }) : undefined });
const assistant = (content: Array<TextContent | ThinkingContent | ToolCall>, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", content, stopReason, api: "openai-codex-responses", provider: "openai-codex", model: "test", timestamp: 2,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const task = (kind: string): Extract<Message, { role: "custom" }> => ({ role: "custom", customType: "subagent", content: `Agent ${kind}`, details: { kind }, display: true, timestamp: 3 });
const final = assistant([text("Answer", "final_answer")]);

describe("Codex fork-history selection and filtering", () => {
  const history: Message[] = [
    user("First task"),
    assistant([text("Investigating", "commentary"), { type: "thinking", thinking: "Private reasoning" }, { type: "toolCall", id: "read", name: "read", arguments: {} }], "toolUse"),
    { role: "toolResult", toolCallId: "read", toolName: "read", content: [text("Tool output")], isError: false, timestamp: 2 },
    final,
    user("Delegate next"),
    task("message"), task("completion"),
    { role: "bashExecution", command: "pwd", output: "/work", exitCode: 0, cancelled: false, truncated: false, timestamp: 2 },
    assistant([text("Delegating", "commentary"), { type: "toolCall", id: "pending", name: "spawn_agent", arguments: {} }], "toolUse"),
  ];

  test("all/default retain users and final answers, not tool exchanges, reasoning, commentary or agent traffic", () => {
    expect(selectForkHistory(history)).toEqual([history[0], final, history[4]]);
    expect(selectForkHistory(history, "all")).toEqual(selectForkHistory(history));
  });
  test("none inherits nothing", () => expect(selectForkHistory(history, "none")).toEqual([]));
  test("last N slices before filtering; messages and completions do not create turns", () => {
    expect(selectForkHistory(history, "1")).toEqual([history[4]]);
    expect(selectForkHistory(history, "2")).toEqual([history[0], final, history[4]]);
  });
  test("new tasks (including older envelopes) count as turns but are not copied", () => {
    const legacy = { ...task("message"), content: "Message Type: NEW_TASK\nPayload:\nTask" };
    const messages = [user("Old"), final, task("task"), final, legacy, final];
    expect(selectForkHistory(messages, "1")).toEqual([final]);
    expect(selectForkHistory(messages, "2")).toEqual([final, final]);
  });
  test("no boundaries yields empty last-N history; oversized N starts at the first boundary, not the preamble", () => {
    const summary: Message = { role: "compactionSummary", summary: "Earlier context", tokensBefore: 200, timestamp: 0 };
    expect(selectForkHistory([summary, final], "2")).toEqual([]);
    expect(selectForkHistory([summary, user("Task"), final], "99")).toEqual([user("Task"), final]);
    expect(selectForkHistory([summary, user("Task"), final], "all")).toEqual([summary, user("Task"), final]);
  });
  test("a mixed assistant entry inherits only its explicitly final text", () => {
    const mixed = assistant([{ type: "thinking", thinking: "Reasoning" }, text("Progress", "commentary"), text("Unclassified"), text("Answer", "final_answer")]);
    expect(selectForkHistory([mixed])).toEqual([final]);
  });
  test("providers without phase metadata use the host's final-answer semantics", () => {
    expect(selectForkHistory([assistant([text("Answer")])])).toEqual([assistant([text("Answer")])]);
    for (const stopReason of ["toolUse", "error", "aborted"] as const) expect(selectForkHistory([assistant([text("Not a final answer")], stopReason)])).toEqual([]);
    expect(selectForkHistory([assistant([text("Interim"), { type: "toolCall", id: "call", name: "read", arguments: {} }])])).toEqual([]);
  });
  test("the child receives independent data and cannot mutate the parent", () => {
    const before = structuredClone(history);
    const selected = selectForkHistory(history);
    const copiedFinal = selected[1]!;
    if (copiedFinal.role !== "assistant") throw new Error("Expected copied final answer");
    copiedFinal.content.splice(0);
    expect(history).toEqual(before);
  });
  test("invalid modes fail instead of selecting arbitrary history", () => {
    for (const mode of ["0", "-1", "1.5", "invalid"]) expect(() => selectForkHistory(history, mode)).toThrow("fork_turns");
  });

  test("session seeding persists only filtered history and does not re-fork an existing child", () => {
    const child = { id: "child", parentId: "root", rootId: "root", taskName: "review", task: "Review", depth: 1, thinkingLevel: "off", status: "completed" as const, forkTurns: "all" };
    const coordinator = new SubagentRuntime({ agents: [child], messages: [] }, { async save() {}, async peer() { throw new Error("No inference needed"); } });
    const attachment = bindSubagentSession("filter-seeding", "root", { messages: history, subscribe: () => () => {} }, coordinator);
    const manager = SessionManager.inMemory();
    try {
      forkSubagentHistory("filter-seeding", child, manager);
      expect(manager.buildSessionContext().messages).toEqual([history[0], final, history[4]]);
      const branch = manager.getBranch();
      expect(branch.at(-1)).toMatchObject({ type: "custom", customType: inheritedContextEntryType, data: undefined });
      forkSubagentHistory("filter-seeding", child, manager);
      expect(manager.getBranch()).toEqual(branch);
      const localId = manager.appendMessage(user("Subagent-local input"));
      const updated = manager.getBranch();
      const boundary = updated.findIndex((entry) => entry.type === "custom" && entry.customType === inheritedContextEntryType);
      expect(updated.slice(0, boundary)).toEqual(branch.slice(0, -1));
      expect(updated.slice(boundary + 1).map((entry) => entry.id)).toEqual([localId]);
    } finally { attachment.dispose(); }
  });
  test("forking history does not inherit the parent's additional tool bindings", () => {
    const parent = SessionManager.inMemory();
    parent.appendCustomEntry("atelier.additional-tools", [{ name: "set_project_settings_dockerfile", context: { projectId: "project-1" } }]);
    parent.appendMessage(user("Investigate this repository"));
    const child = { id: "child", parentId: "root", rootId: "root", taskName: "review", task: "Review", depth: 1, thinkingLevel: "off", status: "completed" as const, forkTurns: "all" };
    const coordinator = new SubagentRuntime({ agents: [child], messages: [] }, { async save() {}, async peer() { throw new Error("No inference needed"); } });
    const attachment = bindSubagentSession("tool-binding-fork", "root", { messages: parent.buildSessionContext().messages, subscribe: () => () => {} }, coordinator);
    const manager = SessionManager.inMemory();
    try {
      forkSubagentHistory("tool-binding-fork", child, manager);
      expect(manager.buildSessionContext().messages).toEqual([user("Investigate this repository")]);
      expect(manager.getEntries().filter((entry) => entry.type === "custom").map((entry) => entry.customType)).toEqual([inheritedContextEntryType]);
    } finally { attachment.dispose(); }
  });

  test("no inherited messages means no boundary marker", () => {
    for (const forkTurns of ["none", "1", "all"]) {
      const child = { id: "child", parentId: "root", rootId: "root", taskName: "preview", task: "Preview", depth: 1, thinkingLevel: "off", status: "completed" as const, forkTurns };
      const coordinator = new SubagentRuntime({ agents: [child], messages: [] }, { async save() {}, async peer() { throw new Error("No inference needed"); } });
      const attachment = bindSubagentSession("empty-fork", "root", { messages: [], subscribe: () => () => {} }, coordinator);
      try {
        const manager = SessionManager.inMemory();
        forkSubagentHistory("empty-fork", child, manager);
        expect(manager.getBranch()).toEqual([]);
      } finally { attachment.dispose(); }
    }
  });
  test("effective compacted context is seeded using child-local summary entries", () => {
    const child = { id: "child", parentId: "root", rootId: "root", taskName: "review", task: "Review", depth: 1, thinkingLevel: "off", status: "completed" as const, forkTurns: "all" };
    const coordinator = new SubagentRuntime({ agents: [child], messages: [] }, { async save() {}, async peer() { throw new Error("No inference needed"); } });
    const parent = SessionManager.inMemory();
    parent.appendMessage(user("Summarized-away task"));
    const kept = parent.appendMessage(user("Retained task"));
    parent.appendCompaction("Earlier context", kept, 200);
    parent.appendMessage(final);
    parent.branchWithSummary(parent.getLeafId(), "Abandoned branch context");
    const attachment = bindSubagentSession("compacted-filter-seeding", "root", { messages: parent.buildSessionContext().messages, subscribe: () => () => {} }, coordinator);
    const manager = SessionManager.inMemory();
    try {
      forkSubagentHistory("compacted-filter-seeding", child, manager);
      expect(manager.getBranch().map((entry) => entry.type)).toEqual(["compaction", "message", "message", "branch_summary", "custom"]);
      expect(manager.buildSessionContext().messages.map((message) => message.role)).toEqual(["compactionSummary", "user", "assistant", "branchSummary"]);
      expect(manager.buildSessionContext().messages[1]).toEqual(user("Retained task"));
      expect(selectForkHistory(parent.buildSessionContext().messages, "1").map((message) => message.role)).toEqual(["user", "assistant", "branchSummary"]);
    } finally { attachment.dispose(); }
  });

});
