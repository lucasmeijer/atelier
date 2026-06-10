import { describe, expect, test } from "bun:test";
import { recordsFromSessionEntries } from "../../src/server/runtime.ts";

describe("recordsFromSessionEntries", () => {
  test("maps pi session message entries to transcript records", () => {
    const entries = [
      { type: "message", id: "e1", parentId: null, timestamp: "2026-06-10T10:00:00Z", message: { role: "user", content: "hello", timestamp: 1760000000000 } },
      {
        type: "message", id: "e2", parentId: "e1", timestamp: "2026-06-10T10:00:05Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me see" },
            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
          ],
          stopReason: "toolUse",
          usage: { output: 12, cost: { total: 0.001 } },
          timestamp: 1760000005000,
        },
      },
      { type: "message", id: "e3", parentId: "e2", timestamp: "2026-06-10T10:00:06Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "out" }], isError: false, timestamp: 1760000006000 } },
      { type: "branch_summary", id: "e4", parentId: "e3", timestamp: "2026-06-10T10:00:07Z", summary: "old branch" },
      { type: "model_change", id: "e5", parentId: "e4", timestamp: "2026-06-10T10:00:08Z", provider: "anthropic", modelId: "claude" },
    ];
    const records = recordsFromSessionEntries(entries);
    expect(records.length).toBe(5);
    expect(records[0]).toMatchObject({ kind: "user", text: "hello", rewindable: false });
    expect(records[1]).toMatchObject({ kind: "assistant", stopReason: "toolUse", outTokens: 12 });
    expect((records[1] as { parts: unknown[] }).parts.length).toBe(2);
    expect(records[2]).toMatchObject({ kind: "toolResult", callId: "c1", text: "out" });
    expect(records[3]).toMatchObject({ kind: "note", tone: "summary" });
    expect(records[4]).toMatchObject({ kind: "note", tone: "system", text: "model → anthropic/claude" });
  });

  test("user entries with a parent are rewindable", () => {
    const records = recordsFromSessionEntries([
      { type: "message", id: "e9", parentId: "e8", timestamp: "2026-06-10T10:00:00Z", message: { role: "user", content: "again", timestamp: 1760000000000 } },
    ]);
    expect(records[0]).toMatchObject({ kind: "user", rewindable: true });
  });
});
