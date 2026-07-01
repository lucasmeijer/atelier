import { describe, expect, test } from "bun:test";
import {
  buildSections,
  formatCost,
  formatDuration,
  formatTokens,
  summarizeSectionStats,
  type TranscriptRecord,
} from "../../src/server/transcript.ts";

function user(id: string, text: string, ts = 1000, rewindable = true): TranscriptRecord {
  return { kind: "user", id, text, images: [], timestamp: ts, rewindable };
}

describe("buildSections", () => {
  test("groups a user message with intermediate items and final text", () => {
    const records: TranscriptRecord[] = [
      user("u1", "do the thing", 1000),
      {
        kind: "assistant",
        id: "a1",
        parts: [
          { type: "thinking", text: "hmm" },
          { type: "toolCall", callId: "c1", name: "bash", args: { command: "ls" } },
        ],
        stopReason: "toolUse",
        outTokens: 100,
        cost: 0.01,
        timestamp: 2000,
      },
      { kind: "toolResult", callId: "c1", text: "file.txt", images: [], isError: false, timestamp: 3000, details: { displayAnsi: "\x1b[32mfile.txt\x1b[0m" } },
      { kind: "assistant", id: "a2", parts: [{ type: "text", text: "All done." }], stopReason: "stop", outTokens: 50, cost: 0.005, timestamp: 4000 },
    ];
    const sections = buildSections(records);
    expect(sections.length).toBe(1);
    const section = sections[0];
    expect(section.user?.text).toBe("do the thing");
    expect(section.userEntryId).toBe("u1");
    expect(section.finalText).toBe("All done.");
    expect(section.items.length).toBe(2); // thinking + tool (final text promoted out)
    expect(section.items[1]).toMatchObject({ type: "tool", tool: { callId: "c1", status: "ok", resultText: "file.txt", details: { displayAnsi: "\x1b[32mfile.txt\x1b[0m" } } });
    expect(section.items[1]).not.toMatchObject({ type: "tool", tool: { resultImages: [] } });
    expect(section.stats).toMatchObject({ tools: 1, outTokens: 150, durationMs: 3000 });
    expect(section.stats.cost).toBeCloseTo(0.015);
  });

  test("a trailing assistant text with toolUse stop is not promoted to final", () => {
    const sections = buildSections([
      user("u1", "go"),
      { kind: "assistant", id: "a1", parts: [{ type: "text", text: "Let me check" }], stopReason: "toolUse", outTokens: 1, cost: 0, timestamp: 2000 },
    ]);
    expect(sections[0].finalText).toBeUndefined();
    expect(sections[0].items.length).toBe(1);
  });

  test("aborted runs surface an error", () => {
    const sections = buildSections([
      user("u1", "go"),
      { kind: "assistant", id: "a1", parts: [{ type: "text", text: "partial" }], stopReason: "aborted", outTokens: 1, cost: 0, timestamp: 2000 },
    ]);
    expect(sections[0].errorMessage).toBe("Run aborted");
  });

  test("consecutive user messages start new sections", () => {
    const sections = buildSections([user("u1", "one"), user("u2", "two")]);
    expect(sections.length).toBe(2);
    expect(sections[0].user?.text).toBe("one");
    expect(sections[1].user?.text).toBe("two");
  });

  test("non-rewindable first message gets no rewind anchor", () => {
    const sections = buildSections([user("u1", "first", 1000, false)]);
    expect(sections[0].userEntryId).toBeUndefined();
  });

  test("notes before any user message form a leading section", () => {
    const sections = buildSections([
      { kind: "note", text: "model → x", tone: "system" },
      user("u1", "hello"),
    ]);
    expect(sections.length).toBe(2);
    expect(sections[0].user).toBeUndefined();
    expect(sections[0].items[0]).toMatchObject({ type: "note" });
  });
});

describe("formatting", () => {
  test("tokens", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(41200)).toBe("41k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });

  test("cost", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.002)).toBe("$0.002");
    expect(formatCost(0.84)).toBe("$0.84");
    expect(formatCost(12.3)).toBe("$12");
  });

  test("duration", () => {
    expect(formatDuration(8000)).toBe("8s");
    expect(formatDuration(134_000)).toBe("2m 14s");
  });

  test("summary line", () => {
    expect(summarizeSectionStats({ tools: 6, durationMs: 134_000, outTokens: 41_200, cost: 0.84 }, { hasThinking: true }))
      .toBe("6 tool calls · thinking · 2m 14s · 41k tok · $0.84");
    expect(summarizeSectionStats({ tools: 0, durationMs: 0, outTokens: 0, cost: 0 }, { hasThinking: false })).toBe("details");
  });
});
