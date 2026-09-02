import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import {
  applyExactEdits,
  createWorkspaceAgentTools,
  executeDeleteCurrentWorkspace,
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

  test("present tool uses a top-level object schema accepted by Moonshot", () => {
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
      expect(present?.parameters.type).toBe("object");
      expect(present?.parameters.anyOf).toBeUndefined();
      expect(present?.parameters.required).toEqual(["kind"]);
      expect(present?.parameters.properties.kind.enum).toEqual(["test-browser", "test-terminal"]);
      expect(present?.parameters.properties.url.type).toBe("string");
      expect(present?.parameters.properties.session.type).toBe("string");
    } finally {
      unregisterBrowser();
      unregisterTerminal();
    }
  });

  test("delete current workspace tool reports blocked safety checks", async () => {
    const result = await executeDeleteCurrentWorkspace("abc", async (force) => ({
      deleted: false,
      blocked: !force,
      details: { workspaceId: "abc", issues: [{ repo: "demo", uncommittedPaths: ["wip.txt"] }] },
    }), false);

    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") throw new Error("expected text content");
    expect(content.text).toContain("was not deleted");
    expect(result.details).toMatchObject({ workspaceId: "abc", deleted: false, blocked: true });
  });
});
