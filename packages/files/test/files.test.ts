import { describe, expect, test } from "bun:test";
import { workspaceRoot } from "@atelier/workspace";
import { FilesPathError, normalizeFilesPath } from "../src/server/files.ts";
import { filesDirectoryFrameId, filesEditorFrameId, renderFilesDirectoryFrame, renderFilesEditorFrame, renderFilesTreeFrame, renderFilesWorkView } from "../src/server/render.ts";

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


describe("Files Work view rendering", () => {
  test("starts with the Files pane expanded when no file is selected", () => {
    const html = renderFilesWorkView("work 1", { id: "workspace" }).bodyHtml!;
    expect(html).toContain("is-files-pane-open");
    expect(html).toContain('aria-label="Collapse Files pane"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("Includes concealed files");
  });

  test("renders a selected file in the editor with the Files pane collapsed", () => {
    const html = renderFilesWorkView("work 1", { id: "workspace", path: "/work/src/example.ts", line: 4 }).bodyHtml!;
    expect(html).not.toContain("is-files-pane-open");
    expect(html).toContain('aria-label="Expand Files pane"');
    expect(html).toContain('data-file-editor-line-value="4"');
    expect(html).toContain("/work/src/example.ts");
    expect(renderFilesWorkView("work 1", { id: "workspace", path: "/work/src/example.ts" }).label).toBe("example.ts");
  });

  test("renders all entries with actions and file switching destinations", () => {
    const html = renderFilesTreeFrame("work 1", "workspace", [
      { name: "folder", path: `${workspaceRoot}/folder`, kind: "directory", size: 0, openable: false },
      { name: ".secret", path: `${workspaceRoot}/.secret`, kind: "file", size: 1200, openable: true },
    ], `${workspaceRoot}/.secret`);
    expect(html).toContain("1.2 KB");
    expect(html).not.toContain('class="files-row-icon" aria-hidden="true">·');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("data-files-destination");
    expect(html).toContain("click->files#openDirectory");
    expect(html).toContain('<svg class="disclosure-icon" aria-hidden="true"');
    expect(html.match(/class="files-actions-toggle action-item__action button secondary icon-only popup-menu-trigger"/g)).toHaveLength(2);
    expect(html).toContain("/files-view/open?path=%2Fwork%2F.secret&amp;filesView=workspace");
    expect(html).toContain(`data-turbo-frame="${filesEditorFrameId("work 1", "workspace")}"`);
    expect(html).toContain("data-action=\"files-view#selectFile\"");
    expect(html).toContain(">Open in new Files view</a>");
    expect(html).toContain(">Copy URL</button>");
    expect(html).toContain(">Download</a>");
    expect(html).toContain("Delete folder</button>");
    expect(html).toContain("Delete file</button>");
    expect(html).toContain("/file-browser/archive?");
  });

  test("renders an expanded folder in its own Turbo Frame", () => {
    const folder = { name: "folder", path: `${workspaceRoot}/folder`, kind: "directory" as const, size: 0, openable: false };
    const html = renderFilesDirectoryFrame("workspace", "view-1", folder, [
      { name: "nested.txt", path: `${workspaceRoot}/folder/nested.txt`, kind: "file", size: 3, openable: true },
    ]);
    expect(html).toStartWith(`<turbo-frame id="${filesDirectoryFrameId("workspace", "view-1", folder.path)}"`);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('class="files-directory-children" role="group"');
    expect(html).toContain("nested.txt");
    expect(html).toContain("view=collapsed");
  });

  test("renders Markdown preview controls inside the Files editor frame", () => {
    const html = renderFilesEditorFrame("workspace", { id: "workspace", path: "/work/README.md" });
    expect(html).toContain('role="group" aria-label="Markdown display"');
    expect(html).toContain('data-action="file-editor#selectPreviewMode"');
    expect(html).toContain("file-editor-preview agent-md");
  });
});
