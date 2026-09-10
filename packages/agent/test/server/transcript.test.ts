import { describe, expect, test } from "bun:test";
import { buildTranscript, finalAssistantText, findTranscriptItem, formatDuration, formatTokens, isFinalAssistantMessage, isToolViewDetails, toolDetailsIndicateError, type TranscriptRecord } from "../../src/server/transcript.ts";

describe("transcript", () => {
  test("preserves record order, joins tool results, and ends Working when the final answer completes", () => {
    const records: TranscriptRecord[] = [
      { kind: "user", id: "u1", text: "go", images: [], timestamp: 1000 },
      { kind: "assistant", id: "a1", parts: [{ type: "thinking", text: "hmm" }, { type: "toolCall", callId: "c1", name: "bash", args: { command: "ls" } }], stopReason: "toolUse", timestamp: 2000 },
      { kind: "toolResult", callId: "c1", text: "file.txt", images: [], isError: false, timestamp: 3000, details: { exitCode: 0, displayAnsi: "file.txt" } },
      { kind: "assistant", id: "a2", parts: [{ type: "text", text: "Done." }], stopReason: "stop", timestamp: 4000 },
    ];
    const items = buildTranscript(records);
    expect(items.map((item) => item.type)).toEqual(["user", "working", "text"]);
    const working = items.find((item) => item.type === "working");
    expect(working?.type === "working" && working.items.map((item) => item.type)).toEqual(["thinking", "tool"]);
    const tool = findTranscriptItem(items, "tool:c1");
    expect(tool?.type === "tool" && tool.tool.resultText).toBe("file.txt");
    expect(tool?.type === "tool" && tool.tool.durationMs).toBe(1000);
    expect(working?.type === "working" && working.completedAt).toBe(4000);
    const text = items.at(-1);
    expect(text?.type === "text" && text.final).toBe(true);
  });

  test("only first rendered part carries an assistant rewind boundary", () => {
    const items = buildTranscript([{ kind: "assistant", id: "a", parts: [{ type: "thinking", text: "one" }, { type: "text", text: "two" }], stopReason: "stop", timestamp: 1 }]);
    expect(items[0]?.rewindEntryId).toBe("a");
    expect(items[1]?.rewindEntryId).toBeUndefined();
  });

  test("reconstructs completed and interrupted historical working sections", () => {
    const items = buildTranscript([
      { kind: "user", id: "u1", text: "finish", images: [], timestamp: 1000 },
      { kind: "assistant", id: "a1", parts: [{ type: "thinking", text: "working" }, { type: "text", text: "Done" }], stopReason: "stop", timestamp: 4000 },
      { kind: "user", id: "u2", text: "cancel", images: [], timestamp: 5000 },
      { kind: "assistant", id: "a2", parts: [{ type: "text", text: "partial" }], stopReason: "aborted", timestamp: 7000 },
    ]);
    const sections = items.filter((item) => item.type === "working");
    expect(sections).toHaveLength(2);
    expect(sections[0]?.completedAt).toBe(4000);
    expect(sections[0]?.items.map((item) => item.type)).toEqual(["thinking"]);
    expect(sections[1]?.completedAt).toBeUndefined();
    expect(sections[1]?.stoppedAt).toBe(7000);
    expect(sections[1]?.items.map((item) => item.type)).toEqual(["text"]);
  });

  test("classifies final messages from content and pi stop reason", () => {
    const text = [{ type: "text", text: "done" }];
    expect(isFinalAssistantMessage(text, "stop")).toBe(true);
    expect(isFinalAssistantMessage(text, "length")).toBe(true);
    expect(isFinalAssistantMessage(text, "deferred")).toBe(true);
    expect(isFinalAssistantMessage(text, "toolUse")).toBe(false);
    expect(isFinalAssistantMessage(text, "pending")).toBe(false);
    expect(isFinalAssistantMessage(text, "error")).toBe(false);
    expect(isFinalAssistantMessage(text, "aborted")).toBe(false);
    expect(isFinalAssistantMessage([...text, { type: "toolCall" }], "stop")).toBe(false);
    expect(isFinalAssistantMessage([{ type: "text", text: " " }], "stop")).toBe(false);

    const commentary = { type: "text", text: "Progress", textSignature: JSON.stringify({ v: 1, phase: "commentary" }) };
    const final = { type: "text", text: "Done", textSignature: JSON.stringify({ v: 1, phase: "final_answer" }) };
    expect(isFinalAssistantMessage([commentary], "stop")).toBe(false);
    expect(isFinalAssistantMessage([commentary, final], "stop")).toBe(true);
    expect(finalAssistantText([commentary, final])).toBe("Done");
  });

  test("keeps session notices outside working with stable distinct keys", () => {
    const items = buildTranscript([
      { kind: "user", id: "u", text: "go", images: [], timestamp: 1000 },
      { kind: "note", text: "one", tone: "system", timestamp: 2000 },
      { kind: "note", text: "two", tone: "warning", timestamp: 3000 },
    ]);
    expect(items.filter((item) => item.type === "note").map((item) => item.key)).toEqual(["note:1", "note:2"]);
  });

  test("errors derive from result details", () => {
    expect(isToolViewDetails({ exitCode: 1, providerMetadata: { trace: "abc" } })).toBe(true);
    expect(isToolViewDetails({ exitCode: 1, optionalProducerField: undefined })).toBe(true);
    expect(isToolViewDetails({ exitCode: "1" })).toBe(false);
    expect(isToolViewDetails({ extensionCallback() {} })).toBe(false);
    expect(toolDetailsIndicateError({ exitCode: 1 })).toBe(true);
    expect(toolDetailsIndicateError({ timedOut: true })).toBe(true);
    expect(toolDetailsIndicateError({ exitCode: 0 })).toBe(false);
  });

  test("compact formatting is stable", () => {
    expect(formatDuration(1_023_000)).toBe("17m3s");
    expect(formatDuration(600_000)).toBe("10m");
    expect(formatTokens(4600)).toBe("4.6k");
    expect(formatTokens(1000)).toBe("1k");
  });
});

test("empty provider failures retain their detail and stop Working without a final response", () => {
  const items = buildTranscript([
    { kind: "user", id: "u", text: "go", images: [], timestamp: 1000 },
    { kind: "assistant", id: "a", parts: [], stopReason: "error", errorMessage: "Expected a provider request object.", timestamp: 1100 },
  ]);
  expect(items.map((item) => item.type)).toEqual(["user", "working", "error"]);
  const working = items[1];
  expect(working?.type).toBe("working");
  if (working?.type !== "working") throw new Error("Missing working section");
  expect(working.stoppedAt).toBe(1100);
  expect(working.completedAt).toBeUndefined();
  expect(working.items).toEqual([]);
  expect(items.at(-1)).toEqual({ type: "error", key: "a:error", text: "Expected a provider request object.", timestamp: 1100 });
});


test("older unmarked history retains its original per-user boundaries", () => {
  const items = buildTranscript([
    { kind: "user", id: "u1", text: "go", images: [], timestamp: 100 },
    { kind: "assistant", id: "a1", parts: [{ type: "thinking", text: "before steering" }], stopReason: "toolUse", timestamp: 200 },
    { kind: "user", id: "u2", text: "instead", images: [], timestamp: 300 },
    { kind: "assistant", id: "a2", parts: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 400 },
  ]);
  const blocks = items.filter(item => item.type === "working");
  expect(blocks.map(block => [block.key, block.completedAt])).toEqual([["u1:working", 300], ["u2:working", 400]]);
  expect(blocks[0]?.items.map(item => item.key)).toEqual(["a1:thinking:0"]);
  expect(items.filter(item => item.type === "text")).toHaveLength(1);
});

test("automatic retries keep their recoverable errors and subsequent tools inside one turn", () => {
  const items = buildTranscript([
    { kind: "user", id: "u", text: "go", images: [], timestamp: 100 },
    { kind: "assistant", id: "retry", parts: [], stopReason: "error", errorMessage: "busy", timestamp: 200 },
    { kind: "assistant", id: "a", parts: [{ type: "toolCall", callId: "tool", name: "bash", args: {} }], stopReason: "toolUse", timestamp: 300 },
    { kind: "toolResult", callId: "tool", text: "failed normally", images: [], isError: true, timestamp: 400 },
    { kind: "assistant", id: "final", parts: [{ type: "thinking", text: "resolved" }, { type: "text", text: "done" }], stopReason: "stop", timestamp: 500 },
  ]);
  expect(items.map(item => item.type)).toEqual(["user", "working", "text"]);
  const block = items[1];
  if (block?.type !== "working") throw new Error("Missing turn");
  expect(block.completedAt).toBe(500);
  expect(block.items.map(item => item.type)).toEqual(["error", "tool", "thinking"]);
  expect(findTranscriptItem(items, "tool:tool")).toMatchObject({ tool: { status: "error" } });
});

test("selected branch paths retain the start identity without mixing continuations", () => {
  const start: TranscriptRecord = { kind: "user", id: "shared", text: "go", images: [], timestamp: 100 };
  const branch = (id: string) => buildTranscript([start,
    { kind: "assistant", id, parts: [{ type: "thinking", text: id }, { type: "text", text: "done" }], stopReason: "stop", timestamp: 200 },
  ]);
  expect(branch("left")[1]?.key).toBe("shared:working");
  expect(branch("right")[1]?.key).toBe("shared:working");
  expect(findTranscriptItem(branch("left"), "right:thinking:0")).toBeUndefined();
  expect(findTranscriptItem(branch("right"), "left:thinking:0")).toBeUndefined();
});

describe("persisted run boundaries", () => {
  const initial: TranscriptRecord[] = [
    { kind: "user", id: "initial", text: "Start", images: [], timestamp: 1000 },
    { kind: "runStart", turnEntryId: "initial", startedAt: 900, timestamp: 1001 },
    { kind: "assistant", id: "progress", parts: [{ type: "thinking", text: "Before steering" }], stopReason: "toolUse", timestamp: 2000 },
    { kind: "user", id: "steer", text: "Focus here", images: [], timestamp: 3000 },
  ];
  const summary: TranscriptRecord = { kind: "timing", turnEntryId: "initial", outcome: "completed", timestamp: 6000,
    timing: { elapsedMs: 5100, toolMs: 2000, inferenceMs: 3100, outputTokens: 50, usageComplete: true } };

  test("steering is nested at consumption between earlier and later activity", () => {
    const items = buildTranscript([...initial,
      { kind: "assistant", id: "after", parts: [{ type: "thinking", text: "After steering" }, { type: "text", text: "Final answer" }], stopReason: "stop", timestamp: 5000 }, summary,
    ]);
    expect(items.map((item) => item.type)).toEqual(["user", "working", "text"]);
    expect(items[1]).toMatchObject({ key: "initial:working", startedAt: 900, completedAt: 6000,
      items: [{ text: "Before steering" }, { type: "user", key: "steer", text: "Focus here", steering: true, rewindEntryId: "steer", timestamp: 3000 }, { text: "After steering" }], timing: summary.timing });
    expect(items[2]).toMatchObject({ text: "Final answer", final: true });
  });

  test("unfinished history still groups steering without needing a completion summary", () => {
    const items = buildTranscript(initial);
    expect(items.map((item) => item.type)).toEqual(["user", "working"]);
    expect(items[1]).toMatchObject({ key: "initial:working", stoppedAt: 3000 });
  });

  test("only run completion, not an assistant answer, releases the run boundary", () => {
    const items = buildTranscript([...initial,
      { kind: "assistant", id: "answer1", parts: [{ type: "text", text: "Answer before more input" }], stopReason: "stop", timestamp: 4000 },
      { kind: "user", id: "steer2", text: "One more thing", images: [], timestamp: 4500 },
      { kind: "assistant", id: "answer2", parts: [{ type: "text", text: "Last answer" }], stopReason: "stop", timestamp: 5000 }, summary,
      { kind: "user", id: "next", text: "Next run", images: [], timestamp: 7000 },
      { kind: "runStart", turnEntryId: "next", startedAt: 7000, timestamp: 7001 },
    ]);
    expect(items.filter((item) => item.type === "working").map((item) => item.key)).toEqual(["initial:working", "next:working"]);
    expect(items.map((item) => item.type)).toEqual(["user", "working", "text", "text", "user", "working"]);
    expect(items[1]).toMatchObject({ items: [
      { type: "thinking" }, { type: "user", key: "steer", steering: true }, { type: "user", key: "steer2", steering: true },
    ] });
    expect(items[4]).toMatchObject({ type: "user", key: "next", steering: undefined });
  });

  test("a retry followed by steering stays inside the same run", () => {
    const items = buildTranscript([initial[0]!, initial[1]!,
      { kind: "assistant", id: "retry", parts: [], stopReason: "error", errorMessage: "Retryable", timestamp: 2000 }, initial[3]!,
      { kind: "assistant", id: "answer", parts: [{ type: "text", text: "Recovered" }], stopReason: "stop", timestamp: 5000 }, summary,
    ]);
    expect(items.map((item) => item.type)).toEqual(["user", "working", "text"]);
    expect(items[1]).toMatchObject({ items: [{ type: "error", text: "Retryable" }, { type: "user", key: "steer", steering: true }] });
  });
});

test("run membership includes steering entries for contributed activity placement", async () => {
  const { applyTranscriptContributions } = await import("../../src/server/transcript-contributions.ts");
  const records: TranscriptRecord[] = [
    { kind: "user", id: "first", text: "Start", images: [], timestamp: 1000 },
    { kind: "runStart", turnEntryId: "first", startedAt: 1000, timestamp: 1001 },
    { kind: "user", id: "steer", text: "Continue here", images: [], timestamp: 2000 },
  ];
  const items = applyTranscriptContributions(buildTranscript(records), {
    rows: [{ item: { type: "extension", key: "delivered", render: () => "", timestamp: 2100 }, placement: { turnEntryId: "steer", relation: "during-turn" } }], anchors: [],
  });
  expect(items.map((item) => item.type)).toEqual(["user", "working"]);
  expect(items[1]).toMatchObject({ inputEntryIds: ["first", "steer"], items: [{ type: "user", key: "steer", steering: true }, { type: "extension", key: "delivered" }] });
});

test("a new persisted run after an interrupted run is not mistaken for steering", () => {
  const items = buildTranscript([
    { kind: "user", id: "old", text: "Interrupted request", images: [], timestamp: 1000 },
    { kind: "runStart", turnEntryId: "old", startedAt: 1000, timestamp: 1001 },
    { kind: "user", id: "steer", text: "Steering before interruption", images: [], timestamp: 2000 },
    { kind: "user", id: "new", text: "Restart recovery", images: [], timestamp: 5000 },
    { kind: "runStart", turnEntryId: "new", startedAt: 5000, timestamp: 5001 },
    { kind: "assistant", id: "final", parts: [{ type: "text", text: "Recovered" }], stopReason: "stop", timestamp: 6000 },
    { kind: "timing", turnEntryId: "new", outcome: "completed", timestamp: 6001,
      timing: { elapsedMs: 1001, toolMs: 0, inferenceMs: 1001, outputTokens: 2, usageComplete: true } },
  ]);
  expect(items.map((item) => item.type)).toEqual(["user", "working", "user", "working", "text"]);
  const blocks = items.filter((item) => item.type === "working");
  expect(blocks[0]).toMatchObject({ key: "old:working", inputEntryIds: ["old", "steer"], stoppedAt: 5000 });
  expect(blocks[1]).toMatchObject({ key: "new:working", inputEntryIds: ["new"], completedAt: 6001 });
});
