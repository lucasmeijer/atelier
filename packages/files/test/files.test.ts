import { describe, expect, test } from "bun:test";
import { workspaceRoot } from "@atelier/workspace";
import { compactDirectoryEntry, FilesPathError, normalizeFilesPath } from "../src/server/files.ts";
import { filesDirectoryFrameId, filesTreeResultsFrameId, renderFilesDirectoryFrame, renderFilesEditorFrame, renderFilesTreeFrame, renderFilesTreeResultsFrame, filesWorkViewPresentation, renderFilesWorkViewBody } from "../src/server/render.ts";

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

  test("compacts chains of sole child directories", async () => {
    const directory = (name: string, path: string) => ({ name, path, kind: "directory" as const, size: 0 });
    const children = new Map([
      [`${workspaceRoot}/modules`, [directory("core", `${workspaceRoot}/modules/core`)]],
      [`${workspaceRoot}/modules/core`, [directory("src", `${workspaceRoot}/modules/core/src`)]],
      [`${workspaceRoot}/modules/core/src`, [{ name: "index.ts", path: `${workspaceRoot}/modules/core/src/index.ts`, kind: "file" as const, size: 12 }]],
    ]);

    const entry = await compactDirectoryEntry(
      directory("modules", `${workspaceRoot}/modules`),
      async (path) => children.get(path) ?? [],
    );

    expect(entry).toEqual({
      name: "modules/core/src/",
      path: `${workspaceRoot}/modules`,
      directoryPath: `${workspaceRoot}/modules/core/src`,
      kind: "directory",
      size: 0,
    });
  });

  test("stops compacting when a directory has multiple children", async () => {
    const entry = { name: "modules", path: `${workspaceRoot}/modules`, kind: "directory" as const, size: 0 };
    const compacted = await compactDirectoryEntry(entry, async () => [
      { name: "core", path: `${workspaceRoot}/modules/core`, kind: "directory", size: 0 },
      { name: "README.md", path: `${workspaceRoot}/modules/README.md`, kind: "file", size: 12 },
    ]);
    expect(compacted).toEqual(entry);
  });
});


describe("Files Work view rendering", () => {
  test("starts with the Files pane expanded when no file is selected", () => {
    const html = renderFilesWorkViewBody("work 1", { id: "workspace" });
    expect(html).toContain("is-files-pane-open");
    expect(html).toContain('aria-label="Collapse Files pane"');
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain("Includes concealed files");
  });

  test("renders a selected file in the editor with the Files pane collapsed", () => {
    const html = renderFilesWorkViewBody("work 1", { id: "workspace", path: "/work/src/example.ts", line: 4 });
    expect(html).not.toContain("is-files-pane-open");
    expect(html).toContain('aria-label="Expand Files pane"');
    expect(html).toContain('data-file-editor-line-value="4"');
    expect(html).toContain("/work/src/example.ts");
    expect(filesWorkViewPresentation({ id: "workspace", path: "/work/src/example.ts" }).label).toBe("example.ts");
  });

  test("renders entries with file switching destinations and selected state", () => {
    const html = renderFilesTreeFrame("work 1", "workspace", [
      { name: "folder", path: `${workspaceRoot}/folder`, kind: "directory", size: 0, openable: false },
      { name: ".secret", path: `${workspaceRoot}/.secret`, kind: "file", size: 1200, openable: true },
    ], `${workspaceRoot}/.secret`);
    expect(html).toContain("1.2 KB");
    expect(html).not.toContain('class="files-row-icon" aria-hidden="true">·');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("data-files-destination");
    expect(html).toContain('class="files-row action-item action-item__primary"');
    expect(html).toContain('<svg class="disclosure-icon" aria-hidden="true"');
    expect(html).toContain("/files-view/open?path=%2Fwork%2F.secret&amp;filesView=workspace");
    expect(html).toContain('data-turbo-stream="true"');
    expect(html).toContain("data-action=\"files-view#selectFile\"");
  });

  test("renders a server-filtered file tree with a debounced Turbo target and busy status", () => {
    const html = renderFilesTreeFrame("work 1", "view-1", []);
    const resultsId = filesTreeResultsFrameId("work 1", "view-1");
    expect(html).toContain('class="managed-list__filter files-filter"');
    expect(html).toContain('data-controller="server-filter"');
    expect(html).toContain('data-action="input->server-filter#submit"');
    expect(html).toContain(`data-turbo-frame="${resultsId}"`);
    expect(html).toContain('name="q"');
    expect(html).toContain('aria-label="Filter files by name"');
    expect(html).toContain('class="files-filter-loading" role="status"');

    const filtered = renderFilesTreeResultsFrame("work 1", "view-1", [], undefined, true);
    expect(filtered).toContain(`id="${resultsId}"`);
    expect(filtered).toContain('aria-label="Matching files"');
    expect(filtered).toContain("No matching files.");
  });

  test("expands the selected file's ancestors and selects its row", () => {
    const selectedPath = `${workspaceRoot}/src/core/example.ts`;
    const html = renderFilesTreeFrame("workspace", "view-1", [{
      name: "src/core/",
      path: `${workspaceRoot}/src`,
      directoryPath: `${workspaceRoot}/src/core`,
      kind: "directory",
      size: 0,
      openable: false,
      children: [{ name: "example.ts", path: selectedPath, kind: "file", size: 10, openable: true }],
    }], selectedPath);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("example.ts");
  });

  test("renders a compact directory chain with one stable Turbo Frame", () => {
    const folder = { name: "modules/core/", path: `${workspaceRoot}/modules`, directoryPath: `${workspaceRoot}/modules/core`, kind: "directory" as const, size: 0, openable: false };
    const html = renderFilesDirectoryFrame("workspace", "view-1", folder);
    expect(html).toStartWith(`<turbo-frame id="${filesDirectoryFrameId("workspace", "view-1", folder.path)}"`);
    expect(html).toContain('class="files-directory-frame action-list"');
    expect(html).toContain("modules/core/");
    expect(html).toContain("path=%2Fwork%2Fmodules");
    expect(html).toContain(`data-files-destination="${workspaceRoot}/modules/core"`);
  });

  test("renders an expanded folder in its own Turbo Frame", () => {
    const folder = { name: "folder", path: `${workspaceRoot}/folder`, kind: "directory" as const, size: 0, openable: false };
    const html = renderFilesDirectoryFrame("workspace", "view-1", folder, [
      { name: "nested.txt", path: `${workspaceRoot}/folder/nested.txt`, kind: "file", size: 3, openable: true },
    ]);
    expect(html).toStartWith(`<turbo-frame id="${filesDirectoryFrameId("workspace", "view-1", folder.path)}"`);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="group"');
    expect(html).toContain("nested.txt");
    expect(html).toContain("view=collapsed");
  });

  test("renders Markdown preview controls inside the Files editor frame", () => {
    const html = renderFilesEditorFrame("workspace", { id: "workspace", path: "/work/README.md" });
    expect(html).toContain('class="text-toggle" role="group" aria-label="Markdown display"');
    expect(html).toContain('class="text-toggle__option"');
    expect(html).toContain('data-action="change-&gt;file-editor#selectPreviewMode"');
    expect(html).toContain('name="preview-mode" value="edit" aria-pressed="true"');
    expect(html).toContain('name="preview-mode" value="preview" aria-pressed="false"');
    expect(html).toContain("file-editor-preview agent-md");
  });

  test("renders the on-disk conflict dialog with resolution actions", () => {
    const html = renderFilesEditorFrame("workspace", { id: "workspace", path: "/work/README.md" });
    expect(html).toContain("File changed on disk");
    expect(html).toContain('aria-label="Dismiss file conflict"');
  });

  test("renders selected-file actions as a toolbar button group", () => {
    const html = renderFilesEditorFrame("work 1", { id: "view-1", path: "/work/src/example.ts" });
    expect(html).toContain('role="group" aria-label="Actions for selected file"');
    expect(html).toContain('aria-label="Download file"');
    expect(html).toContain('aria-label="Delete file"');
    expect(html).toContain('name="path" value="/work/src/example.ts"');
    expect(html).toContain('name="filesView" value="view-1"');
  });
});
