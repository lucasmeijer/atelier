import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import {
  applyExactEdits,
  createDeleteCurrentWorkspaceTool,
  createWorkspaceAgentTools,
  normalizeWorkspacePath,
  registerWorkspacePresenter,
} from "../../src/server/tools.ts";

describe("workspace agent tools", () => {
  test("normalizes paths under /work", () => {
    expect(normalizeWorkspacePath("foo.ts")).toBe("/work/foo.ts");
    expect(normalizeWorkspacePath("/work/foo.ts")).toBe("/work/foo.ts");
    expect(normalizeWorkspacePath("nested/../foo.ts")).toBe("/work/foo.ts");
  });

  test("allows paths outside /work", () => {
    expect(normalizeWorkspacePath("../foo.ts")).toBe("/foo.ts");
    expect(normalizeWorkspacePath("/etc/passwd")).toBe("/etc/passwd");
    expect(normalizeWorkspacePath("/workspace/work/x")).toBe("/workspace/work/x");
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

  test("present tool declares object types inside its union branches", () => {
    const unregisterBrowser = registerWorkspacePresenter("test-browser", () => ({
      kind: "test-browser",
      description: "Present a test browser.",
      parameters: { url: Type.String() },
      execute: async () => ({ content: [{ type: "text" as const, text: "presented" }], details: {} }),
    }));
    const unregisterTerminal = registerWorkspacePresenter("test-terminal", () => ({
      kind: "test-terminal",
      description: "Present a test terminal.",
      parameters: { session: Type.String() },
      execute: async () => ({ content: [{ type: "text" as const, text: "presented" }], details: {} }),
    }));

    try {
      const present = createWorkspaceAgentTools("abc").find((tool) => tool.name === "present");
      expect(present?.parameters.type).toBeUndefined();
      expect(present?.parameters.anyOf).toHaveLength(2);
      expect(present?.parameters.anyOf.every((branch: Record<string, unknown>) => branch.type === "object")).toBe(true);
    } finally {
      unregisterBrowser();
      unregisterTerminal();
    }
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
