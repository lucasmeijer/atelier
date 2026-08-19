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
      { type: "message", id: "e3", parentId: "e2", timestamp: "2026-06-10T10:00:06Z", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "out" }, { type: "image", mimeType: "image/png", data: "abc" }], details: { displayAnsi: "\x1b[31mout\x1b[0m" }, isError: false, timestamp: 1760000006000 } },
      { type: "branch_summary", id: "e4", parentId: "e3", timestamp: "2026-06-10T10:00:07Z", summary: "old branch" },
      { type: "model_change", id: "e5", parentId: "e4", timestamp: "2026-06-10T10:00:08Z", provider: "anthropic", modelId: "claude" },
    ];
    const records = recordsFromSessionEntries(entries);
    expect(records.length).toBe(5);
    expect(records[0]).toMatchObject({ kind: "user", text: "hello", rewindable: false });
    const assistant = records[1];
    expect(assistant).toMatchObject({ kind: "assistant", stopReason: "toolUse" });
    if (assistant.kind !== "assistant") throw new Error("expected an assistant transcript record");
    expect(assistant.parts).toHaveLength(2);
    expect(records[2]).toMatchObject({ kind: "toolResult", callId: "c1", text: "out", images: [{ entryId: "e3", contentIndex: 1 }], details: { displayAnsi: "\x1b[31mout\x1b[0m" } });
    expect(records[3]).toMatchObject({ kind: "note", tone: "summary" });
    expect(records[4]).toMatchObject({ kind: "note", tone: "system", text: "model → anthropic/claude" });
  });

  test("user entries with a parent are rewindable", () => {
    const records = recordsFromSessionEntries([
      { type: "message", id: "e9", parentId: "e8", timestamp: "2026-06-10T10:00:00Z", message: { role: "user", content: "again", timestamp: 1760000000000 } },
    ]);
    expect(records[0]).toMatchObject({ kind: "user", rewindable: true });
  });

  test("narrows malformed image metadata before adding it to transcript records", () => {
    const records = recordsFromSessionEntries([
      {
        type: "message",
        id: "e10",
        parentId: null,
        message: {
          role: "user",
          content: [
            { type: "image", mimeType: 42, data: false },
            { type: "image", mimeType: "image/png", data: "not-an-image" },
          ],
        },
      },
    ]);

    expect(records[0]).toMatchObject({
      kind: "user",
      images: [
        { entryId: "e10", contentIndex: 0, mimeType: undefined },
        { entryId: "e10", contentIndex: 1, mimeType: "image/png" },
      ],
    });
  });
});
