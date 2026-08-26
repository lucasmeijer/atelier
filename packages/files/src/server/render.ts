import { posix } from "node:path";
import { disclosureIconHtml, domId, escapeHtml, workspaceFileEditorOpenUrl, workspaceProxyUrl, type WorkspaceWorkViewPresentation } from "@atelier/shared";
import { workspaceRoot } from "@atelier/workspace";
import type { FileEntry } from "./files.ts";

export function filesFrameId(workspaceId: string): string {
  return domId("workspace", workspaceId, "files");
}

export function filesDirectoryFrameId(workspaceId: string, path: string): string {
  return `files_directory_${Buffer.from(`${workspaceId}\0${path}`).toString("base64url")}`;
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

function directoryToggleUrl(workspaceId: string, entry: FileEntry, showConcealed: boolean, expand: boolean): string {
  const query = new URLSearchParams({ path: entry.path, view: expand ? "inline" : "collapsed" });
  if (showConcealed) query.set("showHidden", "1");
  if (entry.concealed) query.set("concealed", "1");
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

function entryContentUrl(workspaceId: string, entry: FileEntry): string {
  if (entry.kind !== "directory") return workspaceProxyUrl(workspaceId, "file", entry.path);
  return `/workspaces/${encodeURIComponent(workspaceId)}/file-browser/archive?${new URLSearchParams({ path: entry.path })}`;
}

function renderEntryRow(workspaceId: string, entry: FileEntry, showConcealed: boolean, expanded: boolean): string {
  const concealed = entry.concealed ? " concealed" : "";
  const icon = entry.kind === "directory"
    ? `${disclosureIconHtml}<span class="status-spinner sm files-directory-spinner"></span>`
    : entry.kind === "symlink" ? "↗" : "";
  const label = entry.kind === "directory"
    ? `<a class="action-item__label-text" href="${escapeHtml(directoryToggleUrl(workspaceId, entry, showConcealed, !expanded))}" data-turbo-frame="${filesDirectoryFrameId(workspaceId, entry.path)}">${escapeHtml(entry.name)}</a>`
    : entry.openable
      ? `<a class="action-item__label-text" href="${escapeHtml(workspaceFileEditorOpenUrl(workspaceId, entry.path))}" data-turbo-stream="true">${escapeHtml(entry.name)}</a>`
      : `<span class="action-item__label-text">${escapeHtml(entry.name)}</span>`;
  const drop = entry.kind === "directory" ? ` data-files-destination="${escapeHtml(entry.path)}"` : "";
  const actions = entry.kind === "directory"
    ? "click->files#openDirectory dragenter->files#folderDragEnter dragover->files#folderDragOver dragleave->files#folderDragLeave drop->files#folderDrop"
    : "mousedown->files#preserveSelection click->files#selectOrOpen";
  const contentUrl = entryContentUrl(workspaceId, entry);
  const menuId = domId("files_actions", filesDirectoryFrameId(workspaceId, entry.path));
  const downloadName = entry.kind === "directory" ? `${entry.name}.tar.gz` : entry.name;
  const kindLabel = entry.kind === "directory" ? "folder" : "file";
  const expandedAttribute = entry.kind === "directory" ? ` aria-expanded="${expanded}"` : "";
  const viewAsRoot = entry.kind === "directory"
    ? `<a class="action-item action-item__primary" href="${escapeHtml(directoryUrl(workspaceId, entry.path, showConcealed))}" data-turbo-frame="${filesFrameId(workspaceId)}" role="menuitem">View as root</a>`
    : "";
  return `<div class="files-row action-item${concealed} popup-menu-anchor" role="treeitem" tabindex="-1" data-kind="${entry.kind}" data-action="${actions}"${drop}${expandedAttribute}>
    <span class="files-row-icon" aria-hidden="true">${icon}</span>
    <span class="files-row-name action-item__label">${label}</span>
    <span class="files-row-size">${entry.kind === "directory" ? "—" : formatSize(entry.size)}</span>
    <button class="files-actions-toggle action-item__action button secondary icon-only popup-menu-trigger" type="button" aria-label="Actions for ${escapeHtml(entry.name)}" aria-haspopup="menu" aria-controls="${menuId}" popovertarget="${menuId}"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>
    <div class="files-actions-menu popup-menu popup-menu-anchored" id="${menuId}" role="menu" popover="auto">
      ${viewAsRoot}
      <button class="action-item action-item__primary" type="button" role="menuitem" data-files-copy-url="${escapeHtml(contentUrl)}" data-action="files#copyUrl">Copy URL</button>
      <a class="action-item action-item__primary" href="${escapeHtml(contentUrl)}" download="${escapeHtml(downloadName)}" role="menuitem" data-turbo="false">Download</a>
      <form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/file-browser/delete" data-turbo-frame="${filesFrameId(workspaceId)}" data-turbo-confirm="Delete ${escapeHtml(entry.name)}? This cannot be undone.">
        <input type="hidden" name="path" value="${escapeHtml(entry.path)}">
        ${showConcealed ? '<input type="hidden" name="showHidden" value="1">' : ""}
        <button class="action-item action-item__primary is-danger" type="submit" role="menuitem">Delete ${kindLabel}</button>
      </form>
    </div>
  </div>`;
}

function renderEntry(workspaceId: string, entry: FileEntry, showConcealed: boolean): string {
  if (entry.kind === "directory") return renderFilesDirectoryFrame(workspaceId, entry, showConcealed);
  return renderEntryRow(workspaceId, entry, showConcealed, false);
}

export function renderFilesDirectoryFrame(workspaceId: string, entry: FileEntry, showConcealed: boolean, entries?: FileEntry[]): string {
  const expanded = entries !== undefined;
  const children = expanded
    ? `<div class="files-directory-children" role="group">${entries.map((child) => renderEntry(workspaceId, child, showConcealed)).join("") || '<p class="files-empty">This folder is empty</p>'}</div>`
    : "";
  return `<turbo-frame id="${filesDirectoryFrameId(workspaceId, entry.path)}" class="files-directory-frame">${renderEntryRow(workspaceId, entry, showConcealed, expanded)}${children}</turbo-frame>`;
}

export function renderFilesFrame(workspaceId: string, path: string, entries: FileEntry[], showConcealed: boolean): string {
  return `<turbo-frame id="${filesFrameId(workspaceId)}" class="files-frame">
    <div class="files-browser" data-controller="files" data-files-workspace-id-value="${escapeHtml(workspaceId)}" data-files-path-value="${escapeHtml(path)}" data-files-upload-url-value="/workspaces/${encodeURIComponent(workspaceId)}/file-browser/upload" data-action="dragenter->files#dragEnter dragover->files#dragOver dragleave->files#dragLeave drop->files#drop keydown->files#keydown">
      <header class="files-toolbar">
        <nav class="files-breadcrumbs" aria-label="Current folder">${breadcrumbs(workspaceId, path, showConcealed)}</nav>
        <div class="files-toolbar-actions">
          <label class="files-hidden-toggle"><input type="checkbox"${showConcealed ? " checked" : ""} data-action="change->files#toggleHidden"> Show hidden &amp; ignored</label>
          <button class="button secondary icon-only" type="button" title="Refresh files" aria-label="Refresh files" data-action="files#refresh"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.5-2.6L20 9M4 15l2.4 2.6A7 7 0 0 0 17.9 15"/></svg></button>
        </div>
      </header>
      <div class="files-columns" aria-hidden="true"><span>Name</span><span>Size</span><span></span></div>
      <div class="files-tree" role="tree" aria-label="Files in ${escapeHtml(path)}" tabindex="0">
        ${entries.map((entry) => renderEntry(workspaceId, entry, showConcealed)).join("") || '<p class="files-empty">This folder is empty</p>'}
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

export function renderLazyFilesFrame(workspaceId: string): string {
  return `<turbo-frame id="${filesFrameId(workspaceId)}" class="files-frame" src="${escapeHtml(directoryUrl(workspaceId, workspaceRoot, false))}" loading="lazy">
    <div class="files-loading"><span class="status-spinner"></span> Loading files…</div>
  </turbo-frame>`;
}

export function renderFilesWorkView(frameHtml: string): WorkspaceWorkViewPresentation {
  return {
    sourceKey: "files",
    label: "Files",
    reference: { type: "files" },
    kind: "contextual",
    availability: { phase: "live" },
    bodyHtml: `<section class="work-view-pane" data-work-view-source="files">${frameHtml}</section>`,
  };
}
