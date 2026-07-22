import { posix } from "node:path";
import { domId, escapeHtml, type WorkspaceTabContribution } from "@atelier/shared";
import { workspaceRoot } from "@atelier/workspace";
import type { FileEntry } from "./files.ts";

export function filesFrameId(workspaceId: string): string {
  return domId("workspace", workspaceId, "files");
}

function formatSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function directoryUrl(workspaceId: string, path: string, showConcealed: boolean): string {
  const query = new URLSearchParams({ path });
  if (showConcealed) query.set("showHidden", "1");
  return `/workspaces/${encodeURIComponent(workspaceId)}/files?${query}`;
}

function breadcrumbs(workspaceId: string, path: string, showConcealed: boolean): string {
  const relative = posix.relative(workspaceRoot, path);
  const segments = relative ? relative.split("/") : [];
  const crumbs = [{ label: workspaceRoot, path: workspaceRoot }];
  let current = workspaceRoot;
  for (const segment of segments) {
    current = posix.join(current, segment);
    crumbs.push({ label: segment, path: current });
  }
  return crumbs.map((crumb, index) => {
    const currentCrumb = index === crumbs.length - 1;
    return `${index ? '<span class="files-crumb-separator" aria-hidden="true">/</span>' : ""}<a class="files-crumb" href="${escapeHtml(directoryUrl(workspaceId, crumb.path, showConcealed))}" data-turbo-frame="${filesFrameId(workspaceId)}" ${currentCrumb ? 'aria-current="page"' : ""}>${escapeHtml(crumb.label)}</a>`;
  }).join("");
}

function fileRow(workspaceId: string, entry: FileEntry, showConcealed: boolean): string {
  const concealed = entry.concealed ? " concealed" : "";
  const icon = entry.kind === "directory" ? "▸" : entry.kind === "symlink" ? "↗" : "";
  const label = entry.kind === "directory"
    ? `<a href="${escapeHtml(directoryUrl(workspaceId, entry.path, showConcealed))}" data-turbo-frame="${filesFrameId(workspaceId)}">${escapeHtml(entry.name)}</a>`
    : `<span>${escapeHtml(entry.name)}</span>`;
  const drop = entry.kind === "directory" ? ` data-files-destination="${escapeHtml(entry.path)}" data-action="dragenter->files#folderDragEnter dragover->files#folderDragOver dragleave->files#folderDragLeave drop->files#folderDrop"` : "";
  return `<div class="files-row${concealed}" role="treeitem" tabindex="-1" data-kind="${entry.kind}"${drop}>
    <span class="files-row-icon" aria-hidden="true">${icon}</span>
    <span class="files-row-name">${label}</span>
    <span class="files-row-size">${entry.kind === "directory" ? "—" : formatSize(entry.size)}</span>
  </div>`;
}

export function renderFilesFrame(workspaceId: string, path: string, entries: FileEntry[], showConcealed: boolean): string {
  return `<turbo-frame id="${filesFrameId(workspaceId)}" class="files-frame">
    <div class="files-browser" data-controller="files" data-files-workspace-id-value="${escapeHtml(workspaceId)}" data-files-path-value="${escapeHtml(path)}" data-files-upload-url-value="/workspaces/${encodeURIComponent(workspaceId)}/file-browser/upload" data-action="dragenter->files#dragEnter dragover->files#dragOver dragleave->files#dragLeave drop->files#drop keydown->files#keydown">
      <header class="files-toolbar">
        <nav class="files-breadcrumbs" aria-label="Current folder">${breadcrumbs(workspaceId, path, showConcealed)}</nav>
        <label class="files-hidden-toggle"><input type="checkbox"${showConcealed ? " checked" : ""} data-action="change->files#toggleHidden"> Show hidden &amp; ignored</label>
      </header>
      <div class="files-columns" aria-hidden="true"><span>Name</span><span>Size</span></div>
      <div class="files-tree" role="tree" aria-label="Files in ${escapeHtml(path)}" tabindex="0">
        ${entries.map((entry) => fileRow(workspaceId, entry, showConcealed)).join("") || '<p class="files-empty">This folder is empty</p>'}
      </div>
      <div class="files-drop-overlay" aria-hidden="true"><strong>Drop files to upload</strong><span>${escapeHtml(path)}</span></div>
      <footer class="files-upload-status" hidden>
        <div class="files-progress-track"><span data-files-target="progress"></span></div>
        <span data-files-target="status">Uploading…</span>
        <button type="button" data-action="files#cancel">Cancel</button>
      </footer>
    </div>
  </turbo-frame>`;
}

export function renderFilesTab(frameHtml: string): WorkspaceTabContribution {
  return {
    key: "files",
    label: "Files",
    paneHtml: `<section class="tab-pane" data-tab-pane="files">${frameHtml}</section>`,
  };
}
