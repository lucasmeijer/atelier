import { describe, expect, test } from "bun:test";
import { buildTranscript, finalAssistantText, findTranscriptItem, formatDuration, formatTokens, isFinalAssistantMessage, isToolViewDetails, toolDetailsIndicateError, type TranscriptRecord } from "../../src/server/transcript.ts";

describe("transcript", () => {
  test("preserves record order, joins tool results, and ends Working at the last activity", () => {
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
    expect(working?.type === "working" && working.completedAt).toBe(3000);
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
    expect(sections[1]?.items.map((item) => item.type)).toEqual(["text", "error"]);
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

  test("gives id-less notes stable distinct keys inside a working section", () => {
    const items = buildTranscript([
      { kind: "user", id: "u", text: "go", images: [], timestamp: 1000 },
      { kind: "note", text: "one", tone: "system", timestamp: 2000 },
      { kind: "note", text: "two", tone: "warning", timestamp: 3000 },
    ]);
    const working = items.find((item) => item.type === "working");
    expect(working?.type === "working" && working.items.map((item) => item.key)).toEqual(["note:1", "note:2"]);
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
  expect(items.map((item) => item.type)).toEqual(["user", "working"]);
  const working = items[1];
  expect(working?.type).toBe("working");
  if (working?.type !== "working") throw new Error("Missing working section");
  expect(working.stoppedAt).toBe(1100);
  expect(working.completedAt).toBeUndefined();
  expect(working.items).toEqual([{ type: "error", key: "a:error", text: "Expected a provider request object.", timestamp: 1100 }]);
});
