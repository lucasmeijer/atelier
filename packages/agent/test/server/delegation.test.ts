import { afterEach, expect, test } from "bun:test";
import { configureAgentDelegation, type AgentDelegation } from "../../src/server/delegation.ts";
import { closeWorkspaceAgentConversation, unloadWorkspaceAgentRuntime, removeWorkspaceAgentRuntimes, restoreWorkspaceAgentRuntime } from "../../src/server/runtime.ts";
import { recordsFromSessionEntries } from "../../src/server/session-records.ts";
import { attachModelRequestPipeline } from "../../src/server/model-request-pipeline.ts";

const delegation: AgentDelegation = {
  prepare: () => ({}),
  resolveConversation: async () => undefined,
  closingConversation: async () => {},
  removingWorkspace: async () => {},
  projectSessionEntry: () => undefined,
};
afterEach(() => configureAgentDelegation(undefined));

test("unloading does not close delegation; explicit close and workspace removal await it", async () => {
  const operations: string[] = [];
  configureAgentDelegation({
    ...delegation,
    async closingConversation(workspaceId, conversationId) { await Promise.resolve(); operations.push(`close:${workspaceId}:${conversationId}`); },
    async removingWorkspace(workspaceId) { await Promise.resolve(); operations.push(`remove:${workspaceId}`); },
  });
  await unloadWorkspaceAgentRuntime("delegation-lifecycle", "root");
  expect(operations).toEqual([]);
  await closeWorkspaceAgentConversation("delegation-lifecycle", "root");
  expect(operations).toEqual(["close:delegation-lifecycle:root"]);
  await removeWorkspaceAgentRuntimes("delegation-lifecycle");
  expect(operations).toEqual(["close:delegation-lifecycle:root", "remove:delegation-lifecycle"]);
});

test("delegation close failures reach the caller rather than permitting archival", async () => {
  configureAgentDelegation({ ...delegation, async closingConversation() { throw new Error("could not close descendants"); } });
  try {
    await expect(closeWorkspaceAgentConversation("delegation-close-failure", "root")).rejects.toThrow("could not close descendants");
  } finally { restoreWorkspaceAgentRuntime("delegation-close-failure", "root"); }
});

test("delegation consumes its records; without it ordinary custom history remains readable", () => {
  const entry = { type: "custom_message", customType: "task", id: "turn", timestamp: "2026-01-01T00:00:00Z", content: "Task body", display: true };
  configureAgentDelegation({ ...delegation, projectSessionEntry(value) {
    if (value.customType === "task") return [{ kind: "taskStart", id: value.id, timestamp: Date.parse(value.timestamp) }];
  } });
  expect(recordsFromSessionEntries([entry])).toEqual([{ kind: "taskStart", id: "turn", timestamp: Date.parse(entry.timestamp) }]);
  configureAgentDelegation(undefined);
  expect(recordsFromSessionEntries([entry])).toEqual([{ kind: "note", id: "turn", timestamp: Date.parse(entry.timestamp), text: "Task body", tone: "summary" }]);
});

test("request adaptation surrounds Pi serialization, isolates state, and restores host callbacks", async () => {
  const events: string[] = [];
  const convert = async (messages: any[]) => { events.push("pi-convert"); return messages; };
  const payload = (input: any) => { events.push("pi-payload"); return { ...input, original: true }; };
  const session = { agent: { convertToLlm: convert, onPayload: payload } };
  let requestId = 0;
  const detach = attachModelRequestPipeline(session, () => {
    const id = ++requestId;
    let count = 0;
    return {
      messages(messages) { events.push("messages"); count = messages.length; return [...messages, { role: "user", content: "delegation" }]; },
      payload(input) { events.push("payload"); return { ...input, count, requestId: id }; },
      prepared() { events.push("prepared"); },
    };
  });
  try {
    expect(await session.agent.convertToLlm([{ role: "user", content: "actual" }])).toHaveLength(2);
    expect(await session.agent.onPayload({})).toEqual({ original: true, count: 1, requestId: 1 });
    expect(events).toEqual(["messages", "pi-convert", "pi-payload", "payload", "prepared"]);
    await session.agent.convertToLlm([]);
    expect(await session.agent.onPayload({})).toEqual({ original: true, count: 0, requestId: 2 });
  } finally { detach(); }
  expect(session.agent.convertToLlm).toBe(convert);
  expect(session.agent.onPayload).toBe(payload);
});

test("failed request adaptation never records preparation", async () => {
  let prepared = false;
  const session = { agent: { convertToLlm: async (messages: any[]) => messages, onPayload: async (_input: any) => ({}) } };
  const detach = attachModelRequestPipeline(session, () => ({ payload() { throw new Error("bad provider input"); }, prepared() { prepared = true; } }));
  try {
    await session.agent.convertToLlm([]);
    await expect(session.agent.onPayload({})).rejects.toThrow("bad provider input");
    expect(prepared).toBe(false);
  } finally { detach(); }
});

test("preparation failures remain observable and do not return a provider payload", async () => {
  const session = { agent: { convertToLlm: async (messages: any[]) => messages, onPayload: async (_input: any) => ({}) } };
  const detach = attachModelRequestPipeline(session, () => ({ prepared() { throw new Error("could not persist delivery"); } }));
  try {
    await session.agent.convertToLlm([]);
    await expect(session.agent.onPayload({})).rejects.toThrow("could not persist delivery");
  } finally { detach(); }
});

test("SDK Responses payloads normalize optional undefined fields before delegation", async () => {
  const sdkPayload = {
    model: "gpt-5.6-luna",
    input: [{ role: "user", content: [{ type: "input_text", text: "Hello", annotations: undefined }] }],
    stream: true,
    store: false,
    prompt_cache_key: undefined,
    prompt_cache_retention: undefined,
    prompt_cache_options: undefined,
    reasoning: { effort: "medium", summary: undefined },
    tools: [{ type: "function", name: "read", description: undefined, parameters: { type: "object", properties: {} }, strict: false }],
  };
  const events: string[] = [];
  const session = { agent: {
    convertToLlm: async (messages: any[]) => messages,
    onPayload: async (payload: any, _model: { api: string }) => {
      events.push("previous");
      payload.metadata = { source: "previous-hook", optional: undefined };
      // Pi hooks may mutate the request and return undefined.
    },
  } };
  const model = { api: "openai-responses" };
  const detach = attachModelRequestPipeline(session, () => ({
    payload(payload, receivedModel) {
      events.push("delegation");
      expect(receivedModel).toBe(model);
      expect(payload).toEqual(JSON.parse(JSON.stringify(sdkPayload)));
      expect(payload).not.toHaveProperty("prompt_cache_key");
      return { ...payload, input: [{ role: "user", content: [{ type: "input_text", text: "Delegated message" }] }] };
    },
    prepared() { events.push("prepared"); },
  }));
  try {
    await session.agent.convertToLlm([]);
    const result = await session.agent.onPayload(sdkPayload, model);
    expect(result).toEqual({
      ...JSON.parse(JSON.stringify(sdkPayload)),
      input: [{ role: "user", content: [{ type: "input_text", text: "Delegated message" }] }],
    });
    expect(events).toEqual(["previous", "delegation", "prepared"]);
    expect(sdkPayload).toHaveProperty("prompt_cache_key");
  } finally { detach(); }
});

test("non-object provider requests fail before delegation preparation", async () => {
  let prepared = false;
  const session = { agent: { convertToLlm: async (messages: any[]) => messages, onPayload: async (input: any) => input } };
  const detach = attachModelRequestPipeline(session, () => ({ prepared() { prepared = true; } }));
  try {
    await session.agent.convertToLlm([]);
    for (const input of [null, undefined, [], "request", 42]) {
      await expect(session.agent.onPayload(input)).rejects.toThrow("Expected a provider request object.");
    }
    expect(prepared).toBe(false);
  } finally { detach(); }
});
