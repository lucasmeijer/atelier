import { describe, expect, test } from "bun:test";
import { applyExactEdits, createDeleteCurrentWorkspaceTool, normalizeWorkspacePath } from "../../src/server/tools.ts";

describe("workspace agent tools", () => {
  test("normalizes paths under /work", () => {
    expect(normalizeWorkspacePath("foo.ts")).toBe("/work/foo.ts");
    expect(normalizeWorkspacePath("/work/foo.ts")).toBe("/work/foo.ts");
    expect(normalizeWorkspacePath("nested/../foo.ts")).toBe("/work/foo.ts");
  });

  test("rejects path escapes", () => {
    expect(() => normalizeWorkspacePath("../foo.ts")).toThrow();
    expect(() => normalizeWorkspacePath("/etc/passwd")).toThrow();
    expect(() => normalizeWorkspacePath("/workspace/work/x")).toThrow();
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

  test("delete current workspace tool reports blocked safety checks", async () => {
    const tool = createDeleteCurrentWorkspaceTool("abc", async (force) => ({
      deleted: false,
      blocked: !force,
      details: { workspaceId: "abc", issues: [{ repo: "demo", uncommittedPaths: ["wip.txt"], outgoingCommits: [] }] },
    }));

    const result = await tool.execute("call-1", { force: false }, undefined, undefined, {} as never);

    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") throw new Error("expected text content");
    expect(content.text).toContain("was not deleted");
    expect(result.details).toMatchObject({ workspaceId: "abc", deleted: false, blocked: true });
  });
});
