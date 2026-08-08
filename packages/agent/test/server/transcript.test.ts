import { describe, expect, test } from "bun:test";
import { buildTranscript, formatDuration, formatTokens, type TranscriptRecord } from "../../src/server/transcript.ts";
import { parseToolInput, parseToolResultDetails } from "../../src/server/tool-domain.ts";

describe("flat transcript", () => {
  test("preserves record order and joins tool results", () => {
    const records: TranscriptRecord[] = [
      { kind: "user", id: "u1", text: "go", images: [], timestamp: 1000 },
      { kind: "assistant", id: "a1", parts: [{ type: "thinking", text: "hmm" }, { type: "toolCall", callId: "c1", input: parseToolInput("bash", { command: "ls" }) }], stopReason: "toolUse", timestamp: 2000 },
      { kind: "toolResult", callId: "c1", text: "file.txt", images: [], isError: false, timestamp: 3000, details: parseToolResultDetails("bash", { exitCode: 0, displayAnsi: "file.txt" }) },
      { kind: "assistant", id: "a2", parts: [{ type: "text", text: "Done." }], stopReason: "stop", timestamp: 4000 },
    ];
    const items = buildTranscript(records);
    expect(items.map((item) => item.type)).toEqual(["user", "thinking", "tool", "text"]);
    const tool = items.find((item) => item.type === "tool");
    expect(tool?.type === "tool" && tool.tool.resultText).toBe("file.txt");
    expect(tool?.type === "tool" && tool.tool.durationMs).toBe(1000);
    const text = items.at(-1);
    expect(text?.type === "text" && text.final).toBe(true);
  });

  test("only first rendered part carries an assistant rewind boundary", () => {
    const items = buildTranscript([{ kind: "assistant", id: "a", parts: [{ type: "thinking", text: "one" }, { type: "text", text: "two" }], stopReason: "stop", timestamp: 1 }]);
    expect(items[0]?.rewindEntryId).toBe("a");
    expect(items[1]?.rewindEntryId).toBeUndefined();
  });

  test("compact formatting is stable", () => {
    expect(formatDuration(1_023_000)).toBe("17m3s");
    expect(formatDuration(600_000)).toBe("10m");
    expect(formatTokens(4600)).toBe("4.6k");
    expect(formatTokens(1000)).toBe("1k");
  });
});
