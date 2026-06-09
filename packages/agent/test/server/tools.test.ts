import { describe, expect, test } from "bun:test";
import { applyExactEdits, normalizeWorkspacePath } from "../../src/server/tools.ts";

describe("workspace agent tools", () => {
  test("normalizes paths under /repos", () => {
    expect(normalizeWorkspacePath("foo.ts")).toBe("/repos/foo.ts");
    expect(normalizeWorkspacePath("/repos/foo.ts")).toBe("/repos/foo.ts");
    expect(normalizeWorkspacePath("nested/../foo.ts")).toBe("/repos/foo.ts");
  });

  test("rejects path escapes", () => {
    expect(() => normalizeWorkspacePath("../foo.ts")).toThrow();
    expect(() => normalizeWorkspacePath("/etc/passwd")).toThrow();
    expect(() => normalizeWorkspacePath("/workspace/repos/x")).toThrow();
  });

  test("applies exact edits", () => {
    expect(applyExactEdits("hello world", [{ oldText: "world", newText: "atelier" }])).toBe("hello atelier");
    expect(applyExactEdits("a b c", [{ oldText: "a", newText: "A" }, { oldText: "c", newText: "C" }])).toBe("A b C");
  });

  test("rejects missing, duplicate, and overlapping edits", () => {
    expect(() => applyExactEdits("abc", [{ oldText: "x", newText: "y" }])).toThrow();
    expect(() => applyExactEdits("abc abc", [{ oldText: "abc", newText: "x" }])).toThrow();
    expect(() => applyExactEdits("abcdef", [{ oldText: "abc", newText: "x" }, { oldText: "bcd", newText: "y" }])).toThrow();
  });
});
