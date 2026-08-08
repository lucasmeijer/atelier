import { describe, expect, test } from "bun:test";
import { parseStreamingToolInput, parseToolInput, parseToolResultDetails, toolResultIndicatesError } from "../../src/server/tool-domain.ts";

describe("tool domain parsing", () => {
  test("normalizes known tool arguments at ingress", () => {
    expect(parseToolInput("bash", { command: "ls", timeout: 30 })).toEqual({ kind: "bash", name: "bash", command: "ls", timeoutSeconds: 30 });
    expect(parseToolInput("read", { file_path: "a.ts", offset: 4, limit: 2 })).toEqual({ kind: "read", name: "read", path: "a.ts", offset: 4, limit: 2 });
    expect(parseToolInput("write", { path: "a.ts", content: "text" })).toEqual({ kind: "write", name: "write", path: "a.ts", content: "text" });
    expect(parseToolInput("edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: 1, newText: "ignored" }] })).toEqual({ kind: "edit", name: "edit", path: "a.ts", operations: [{ oldText: "a", newText: "b" }] });
  });

  test("keeps arbitrary tools as validated JSON objects", () => {
    expect(parseToolInput("custom", { path: "a.ts", nested: [true, null, 3] })).toEqual({ kind: "generic", name: "custom", args: { path: "a.ts", nested: [true, null, 3] } });
    expect(parseToolInput("custom", ["not", "an", "object"])).toEqual({ kind: "generic", name: "custom", args: undefined });
  });

  test("normalizes result metadata before transcript construction", () => {
    const bash = parseToolResultDetails("bash", { exitCode: 7, displayAnsi: "red", aborted: false, timedOut: false });
    expect(bash).toMatchObject({ exitCode: 7, aborted: false, timedOut: false, displayAnsi: "red" });
    expect(toolResultIndicatesError(bash)).toBe(true);
    expect(toolResultIndicatesError(parseToolResultDetails("generic", { timedOut: true }))).toBe(true);
    expect(toolResultIndicatesError(parseToolResultDetails("generic", { exitCode: 0 }))).toBe(false);
    expect(parseToolResultDetails("edit", { patch: "@@ patch" })).toMatchObject({ patch: "@@ patch" });
  });

  test("produces typed inputs while arguments are still streaming", () => {
    expect(parseStreamingToolInput("write", '{"path":"a.ts","content":"one\\ntwo')).toEqual({ kind: "write", name: "write", path: "a.ts", content: "one\ntwo" });
  });
});
