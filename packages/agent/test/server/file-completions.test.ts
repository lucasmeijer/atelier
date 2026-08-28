import { describe, expect, test } from "bun:test";
import { workspaceRoot } from "@atelier/workspace";
import { fileCompletionSearchSpec, renderFileCompletionMenu } from "../../src/server/file-completions.ts";

describe("file completions", () => {
  test("resolves ordinary prefixes from the workspace working directory", () => {
    expect(fileCompletionSearchSpec("rout", "direct")).toEqual({ baseDir: workspaceRoot, query: "rout", displayBase: "" });
    expect(fileCompletionSearchSpec("packages/agent/rou", "direct")).toEqual({
      baseDir: `${workspaceRoot}/packages/agent/`,
      query: "rou",
      displayBase: "packages/agent/",
    });
  });

  test("preserves absolute and home-relative search roots", () => {
    expect(fileCompletionSearchSpec("/tmp/bla", "direct")).toEqual({ baseDir: "/tmp/", query: "bla", displayBase: "/tmp/" });
    expect(fileCompletionSearchSpec("~/notes/da", "direct")).toEqual({ baseDir: "~/notes/", query: "da", displayBase: "~/notes/" });
  });

  test("scopes fuzzy searches after an explicit directory", () => {
    expect(fileCompletionSearchSpec("src/components/but", "fuzzy")).toEqual({
      baseDir: `${workspaceRoot}/src/components/`,
      query: "but",
      displayBase: "src/components/",
    });
    expect(fileCompletionSearchSpec("button", "fuzzy")).toEqual({ baseDir: workspaceRoot, query: "button", displayBase: "" });
  });

  test("renders escaped, typed server-side options", () => {
    const html = renderFileCompletionMenu([
      { path: "src/a&b.ts", directory: false },
      { path: "src/widgets", directory: true },
    ]);
    expect(html).toContain('role="listbox"');
    expect(html).toContain('data-completion-kind="file"');
    expect(html).toContain('data-file-path="src/a&amp;b.ts"');
    expect(html).toContain('data-file-path="src/widgets/"');
    expect(html).toContain('data-file-directory="true"');
    expect(html).not.toContain("Directory");
    expect(html).not.toContain("agent-file-name");
    expect(html).not.toContain("a&b.ts");
  });
});
