import { isJsonObject, type JsonObject } from "@atelier/core";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { describe, expect, test } from "bun:test";
import { agentPath, messageEnvelope, modelMessage, parseForkTurns, codexStatus } from "../../src/server/subagent-protocol.ts";
import { SubagentModelInput } from "../../src/server/subagent-model-input.ts";
import { createSubagentTools } from "../../src/server/subagent-tools.ts";
import { SubagentRuntime, type SubagentState, type SubagentMessage } from "../../src/server/subagent-runtime.ts";
import { forkSubagentHistory } from "../../src/server/subagents.ts";

const state: SubagentState = {
  agents: [{ id: "worker-id", parentId: "root-id", rootId: "root-id", taskName: "review", task: "Review", depth: 1, thinkingLevel: "low", status: "completed", result: "Done." }],
  messages: [],
};
const message: SubagentMessage = { id: "message-id", from: "worker-id", to: "root-id", kind: "message", text: "Progress <one> & two", timestamp: "2026-09-05T00:00:00.000Z", delivery: "queued" };

describe("pinned Codex V2 plaintext protocol", () => {
  test("matches the MESSAGE, NEW_TASK and FINAL_ANSWER envelopes without IDs", () => {
    expect(messageEnvelope(state, message)).toBe("Message Type: MESSAGE\nTask name: /root\nSender: /root/review\nPayload:\nProgress <one> & two");
    expect(messageEnvelope(state, { ...message, from: "root-id", to: "worker-id", kind: "task", text: "Review now" })).toBe("Message Type: NEW_TASK\nTask name: /root/review\nSender: /root\nPayload:\nReview now");
    expect(messageEnvelope(state, { ...message, kind: "completion", text: "Done." })).toBe("Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/review\nPayload:\nDone.");
  });

  test.each(["", " \n\t"])("blank completion %j retains the FINAL_ANSWER envelope", (text) => {
    const completion = { ...message, kind: "completion" as const, text };
    const envelope = `Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/review\nPayload:\n${text}`;
    expect(messageEnvelope(state, completion)).toBe(envelope);
    expect(modelMessage(state, completion).content).toEqual([{ type: "input_text", text: envelope }]);
  });

  test("emits the native AgentMessage input item, not a user or assistant role message", () => {
    expect(modelMessage(state, message)).toEqual({ type: "agent_message", author: "/root/review", recipient: "/root", content: [{ type: "input_text", text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/review\nPayload:\nProgress <one> & two" }] });
    const bridge = new SubagentModelInput();
    const placeholder = bridge.placeholder(modelMessage(state, message));
    const payload = { input: [{ role: "user", content: [{ type: "input_text", text: "Actual user request" }] }, { role: "user", content: [{ type: "input_text", text: placeholder }] }], tools: [] };
    expect(bridge.transform(payload, "openai-codex-responses")).toEqual({ ...payload, input: [payload.input[0], modelMessage(state, message)] });
    expect(JSON.stringify(bridge.transform(payload, "openai-codex-responses"))).not.toContain(placeholder);
    expect(payload.input[1]!.role).toBe("user"); // transformation does not mutate Pi's context
  });

  test("ordinary text cannot impersonate native agent traffic and misplaced native placeholders fail explicitly", () => {
    const bridge = new SubagentModelInput();
    bridge.placeholder(modelMessage(state, message));
    const payload = { input: [{ role: "user", content: [{ type: "input_text", text: messageEnvelope(state, message) }] }] };
    expect(bridge.transform(payload, "openai-codex-responses")).toEqual(payload);
    expect(() => bridge.transform(payload, "anthropic-messages")).toThrow("Native agent-message placeholders");
  });

  test.each(["anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai"])("%s receives the attributed plaintext envelope as a normal user message", (api) => {
    const bridge = new SubagentModelInput();
    const converted = bridge.forModel(modelMessage(state, message), api, 42);
    expect(converted).toEqual({ role: "user", content: messageEnvelope(state, message), timestamp: 42 });
    const payload = { messages: [converted] };
    expect(bridge.transform(payload, api)).toEqual(payload);
    expect(JSON.stringify(payload)).not.toContain("atelier-agent-message:");
    expect(JSON.stringify(payload)).not.toContain('"type":"agent_message"');
  });

  test("model changes remap historical agent messages without mutating their envelopes", () => {
    const bridge = new SubagentModelInput();
    const original = modelMessage(state, message);
    const native = bridge.forModel(original, "openai-codex-responses", 42);
    expect(bridge.transform({ input: [{ role: "user", content: [{ type: "input_text", text: native.content }] }] }, "openai-codex-responses").input).toEqual([original]);
    bridge.clear();
    expect(bridge.forModel(original, "anthropic-messages", 42).content).toBe(messageEnvelope(state, message));
    expect(original.type).toBe("agent_message");
  });

  test("only the V2 tool family is exposed; optional role/model overrides are disabled", () => {
    const tools = createSubagentTools("workspace", "root");
    expect(tools.map((tool) => tool.name)).toEqual(["spawn_agent", "send_message", "followup_task", "list_agents", "wait_agent", "interrupt_agent"]);
    const schemas = Object.fromEntries(tools.map((tool) => [tool.name, JSON.parse(JSON.stringify(tool.parameters))]));
    expect(schemas.spawn_agent.required).toEqual(["task_name", "message"]);
    expect(Object.keys(schemas.spawn_agent.properties).sort()).toEqual(["fork_turns", "message", "task_name"]);
    expect(schemas.send_message).toEqual({ type: "object", additionalProperties: false, required: ["target", "message"], properties: { target: { type: "string", description: "Relative or canonical task name to message (from spawn_agent)." }, message: { type: "string", description: "Message text to queue on the target agent." } } });
    expect(schemas.wait_agent.properties.timeout_ms).toEqual({ type: "number", description: "Timeout in milliseconds. Defaults to 30000, min 10000, max 3600000." });
    expect(Object.keys(schemas.list_agents.properties)).toEqual(["path_prefix"]);
    expect(tools.find((tool) => tool.name === "followup_task")!.description).toBe("Send a follow-up task to an existing non-root target agent and trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes.");
    expect(JSON.stringify(schemas)).not.toContain("encrypted");
  });

  test("status encoding matches Codex rather than Atelier's lifecycle labels", () => {
    expect(codexStatus(state.agents[0]!)).toEqual({ completed: "Done." });
    expect(codexStatus({ ...state.agents[0]!, status: "failed", result: "Failure" })).toEqual({ errored: "Failure" });
    expect(codexStatus({ ...state.agents[0]!, status: "starting" })).toBe("pending_init");
    expect(parseForkTurns()).toBe("all");
    expect(parseForkTurns("3")).toBe("3");
    expect(() => parseForkTurns("0")).toThrow("fork_turns");
    expect(() => parseForkTurns("1.5")).toThrow("fork_turns");
  });
});

test("paths resolve relative to the caller, allowing equal leaf names in different branches", async () => {
  const runtime = new SubagentRuntime({ agents: [], messages: [] }, {
    async save() {},
    async peer() { return { model: () => undefined, thinkingLevel: () => "off", pendingInput: () => undefined, async send() {}, async abort() {} }; },
  });
  const a = await runtime.spawn("root", "a", "A");
  const b = await runtime.spawn("root", "b", "B");
  const aa = await runtime.spawn(a.id, "review", "A review");
  const bb = await runtime.spawn(b.id, "review", "B review");
  expect(agentPath(runtime.state, aa.id)).toBe("/root/a/review");
  expect(runtime.target(a.id, "review").id).toBe(aa.id);
  expect(runtime.target(b.id, "review").id).toBe(bb.id);
  await runtime.followup(a.id, "/root/b/review", "Cross-branch task");
  expect(runtime.state.messages.at(-1)!.to).toBe(bb.id);
});

test("a fresh fork is not attempted when restoring an existing child transcript", () => {
  let inspected = false;
  forkSubagentHistory("workspace", { ...state.agents[0]!, forkTurns: "all" }, { getBranch() { inspected = true; return [{ type: "message" }]; } });
  expect(inspected).toBe(true);
});

test("provider tools carry Codex's output schemas even before any agent messages arrive", () => {
  const bridge = new SubagentModelInput();
  const result = bridge.transform({ input: [], tools: [{ type: "function", name: "wait_agent", parameters: {} }, { type: "function", name: "read", parameters: {} }] }, "openai-codex-responses");
  expect(result.tools).toMatchObject([{ name: "wait_agent", strict: false, output_schema: { required: ["message", "timed_out"], additionalProperties: false } }, { name: "read" }]);
});

test("receipt is durable before a busy recipient adds the message to context", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const persisted: SubagentState[] = [];
  const runtime = new SubagentRuntime(structuredClone(state), {
    async save(snapshot) { persisted.push(snapshot); },
    async peer() { return { model: () => undefined, thinkingLevel: () => "off", pendingInput: () => undefined, async send(message) { await gate; await runtime.delivered(message.id); }, async abort() {} }; },
  });
  const sending = runtime.send("worker-id", "/root", "Arrived while the parent was busy");
  await Bun.sleep(0);
  expect(persisted.at(-1)!.messages[0]).toMatchObject({ delivery: "queued", text: "Arrived while the parent was busy" });
  const id = persisted.at(-1)!.messages[0]!.id;
  release();
  await sending;
  expect(persisted.at(-1)!.messages).toHaveLength(1);
  expect(persisted.at(-1)!.messages[0]).toMatchObject({ id, delivery: "delivered" });
});


test("Anthropic's real request serializer receives user-message envelopes without native placeholders", async () => {
  const bridge = new SubagentModelInput();
  const mapped = bridge.forModel(modelMessage(state, message), "anthropic-messages", 42);
  let request: JsonObject | undefined;
  const result = await streamAnthropic({
    id: "claude-sonnet-4-20250514", name: "Claude", provider: "anthropic", api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com", reasoning: false, input: ["text"],
    contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }, { messages: [mapped] }, {
    apiKey: "serializer-inspection-only", cacheRetention: "none",
    onPayload(payload) {
      if (!isJsonObject(payload)) throw new Error("Expected an Anthropic request object");
      request = bridge.transform(payload, "anthropic-messages");
      throw new Error("Stop after serialization; no network request");
    },
    fetch: Object.assign(async () => { throw new Error("Unexpected network request"); }, { preconnect() {} }),
  }).result();
  expect(request?.messages).toEqual([{ role: "user", content: messageEnvelope(state, message) }]);
  expect(JSON.stringify(request)).not.toContain("atelier-agent-message:");
  expect(result.errorMessage).toContain("Stop after serialization");
});

test("session attachments unsubscribe and cannot unbind a replacement session", async () => {
  const { bindSubagentSession, rootAgentStatus } = await import("../../src/server/subagents.ts");
  let subscriptions = 0;
  const session = () => ({ messages: [], isStreaming: false, subscribe() { subscriptions++; return () => { subscriptions--; }; } });
  const coordinator = new SubagentRuntime({ agents: [], messages: [] }, { async save() {}, async peer() { throw new Error("No inference requested"); } });
  const first = bindSubagentSession("attachment-test", "root", session(), coordinator);
  const replacement = bindSubagentSession("attachment-test", "root", session(), coordinator);
  await first.dispose();
  expect(subscriptions).toBe(1);
  expect(rootAgentStatus("attachment-test", "root")).toEqual({ completed: null });
  await replacement.dispose();
  expect(subscriptions).toBe(0);
  expect(() => rootAgentStatus("attachment-test", "root")).toThrow("Root agent session is not loaded");
});
