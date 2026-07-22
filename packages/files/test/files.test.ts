import { describe, expect, test } from "bun:test";
import { workspaceRoot } from "@atelier/workspace";
import { FilesPathError, normalizeFilesPath } from "../src/server/files.ts";
import { renderFilesFrame } from "../src/server/render.ts";

describe("files paths", () => {
  test("defaults to the configured workspace root", () => {
    expect(normalizeFilesPath(null)).toBe(workspaceRoot);
  });

  test("allows descendants and normalizes their path", () => {
    expect(normalizeFilesPath(`${workspaceRoot}/src/../test`)).toBe(`${workspaceRoot}/test`);
  });

  test("rejects absolute paths and traversal outside the workspace root", () => {
    expect(() => normalizeFilesPath("/etc")).toThrow(FilesPathError);
    expect(() => normalizeFilesPath(`${workspaceRoot}/../etc`)).toThrow("outside the workspace");
  });
});

describe("files rendering", () => {
  test("renders folders, sizes, breadcrumbs, and concealed entries", () => {
    const html = renderFilesFrame("work 1", `${workspaceRoot}/src`, [
      { name: "folder", path: `${workspaceRoot}/src/folder`, kind: "directory", size: 0, concealed: false },
      { name: ".secret", path: `${workspaceRoot}/src/.secret`, kind: "file", size: 1200, concealed: true },
    ], true);
    expect(html).toContain(workspaceRoot);
    expect(html).toContain("1.2 KB");
    expect(html).toContain("files-row concealed");
    expect(html).toContain("data-files-destination");
    expect(html).toContain("showHidden=1");
  });
});
