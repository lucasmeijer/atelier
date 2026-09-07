import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { modelRuntimeWithUsageTracking, trackUsageStream } from "../../src/server/usage-tracking.ts";

function message(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "gpt", content: [], stopReason, timestamp: Date.now(),
    usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 0, totalTokens: 175, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test("records once when the same stream is consumed by result and iterator", async () => {
  const source = createAssistantMessageEventStream();
  const recorded: AssistantMessage[] = [];
  const stream = trackUsageStream(source, (message) => { recorded.push(message); });
  const completed = message();
  source.push({ type: "done", reason: "stop", message: completed });
  expect(await stream.result()).toBe(completed);
  for await (const event of stream) expect(event.type).toBe("done");
  await stream.result();
  expect(recorded).toEqual([completed]);
});

test("records partial usage from aborted and failed responses", async () => {
  for (const reason of ["aborted", "error"] as const) {
    const source = createAssistantMessageEventStream();
    const recorded: AssistantMessage[] = [];
    const stream = trackUsageStream(source, (message) => { recorded.push(message); });
    source.push({ type: "error", reason, error: message(reason) });
    for await (const _event of stream) { /* drive the normal inference consumer */ }
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.usage.totalTokens).toBe(175);
  }
});

test("counts result-only summarization and separate retry attempts independently", async () => {
  const records: number[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const source = createAssistantMessageEventStream();
    const stream = trackUsageStream(source, (message) => { records.push(message.usage.totalTokens); });
    source.push({ type: "done", reason: "stop", message: message() });
    await stream.result();
  }
  expect(records).toEqual([175, 175]);
});

test("persistence failures are visible to both consumer paths", async () => {
  for (const resultOnly of [false, true]) {
    const source = createAssistantMessageEventStream();
    const stream = trackUsageStream(source, () => { throw new Error("disk full"); });
    source.push({ type: "done", reason: "stop", message: message() });
    const consume = async () => { if (resultOnly) await stream.result(); else for await (const _event of stream) { /* consume */ } };
    await expect(consume()).rejects.toThrow("disk full");
  }
});

test("runtime wrapper counts new responses, not inherited context", async () => {
  const model: Model<"openai-codex-responses"> = { provider: "openai-codex", id: "gpt", name: "GPT", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 };
  const runtime: Pick<ModelRuntime, "streamSimple"> = {
    streamSimple(_model, context) {
      expect(context.messages).toHaveLength(2);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: message() });
      return stream;
    },
  };
  const records: number[] = [];
  const wrapped = modelRuntimeWithUsageTracking(runtime, { record(provider, model, usage) {
    expect(provider).toBe("openai-codex");
    expect(model).toBe("gpt");
    records.push(usage.totalTokens);
  } });
  await wrapped.streamSimple(model, { messages: [message(), message()] }).result();
  expect(records).toEqual([175]);
});


test("concurrent result and iterator consumers still record only once", async () => {
  const source = createAssistantMessageEventStream();
  const records: AssistantMessage[] = [];
  const stream = trackUsageStream(source, (message) => { records.push(message); });
  const result = stream.result();
  const iteration = (async () => { for await (const _event of stream) { /* consume concurrently */ } })();
  const completed = message();
  source.push({ type: "done", reason: "stop", message: completed });
  await Promise.all([result, iteration]);
  expect(records).toEqual([completed]);
});
