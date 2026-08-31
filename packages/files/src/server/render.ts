import { posix } from "node:path";
import { actionItemHtml } from "@atelier/design-system/action-item";
import { copyButtonHtml } from "@atelier/design-system/copy-button";
import { Icons } from "@atelier/design-system/icons";
import { domId, escapeHtml, workspaceFileOpenUrl, workspaceProxyUrl, type WorkspaceWorkViewPresentation } from "@atelier/shared";
import { workspaceRoot } from "@atelier/workspace";
import type { FileEntry } from "./files.ts";
import { defaultFilesViewId, type FilesView } from "./state.ts";

export function filesTreeFrameId(workspaceId: string, viewId: string): string {
  return domId("workspace", workspaceId, "files", viewId, "tree");
}

export function filesEditorFrameId(workspaceId: string, viewId: string): string {
  return domId("workspace", workspaceId, "files", viewId, "editor");
}

export function filesTreeResultsFrameId(workspaceId: string, viewId: string): string {
  return domId("workspace", workspaceId, "files", viewId, "tree", "results");
}

export function filesDirectoryFrameId(workspaceId: string, viewId: string, path: string): string {
  return `files_directory_${Buffer.from(`${workspaceId}\0${viewId}\0${path}`).toString("base64url")}`;
}

export function filesRefreshSignalId(workspaceId: string): string {
  return domId("files_refresh_signal", workspaceId);
}

export function renderFilesRefreshSignal(workspaceId: string): string {
  return `<span id="${filesRefreshSignalId(workspaceId)}" data-controller="files-refresh-signal" data-files-refresh-signal-workspace-id-value="${escapeHtml(workspaceId)}" hidden></span>`;
}

function filesPaneToggle(action: "expand" | "collapse"): string {
  const label = `${action === "expand" ? "Expand" : "Collapse"} Files pane`;
  return `<button class="button secondary icon-only${action === "expand" ? " files-pane-expand" : ""}" type="button" title="${label}" aria-label="${label}" data-action="files-view#${action}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM15 4v16"/></svg></button>`;
}

function formatSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function directoryToggleUrl(workspaceId: string, viewId: string, path: string, expand: boolean): string {
  const query = new URLSearchParams({ path, view: expand ? "inline" : "collapsed", filesView: viewId });
  return `/workspaces/${encodeURIComponent(workspaceId)}/files?${query}`;
}

function selectedFileActions(workspaceId: string, view: FilesView): string {
  const path = view.path!;
  const name = posix.basename(path);
  const contentUrl = workspaceProxyUrl(workspaceId, "file", path);
  const copyButton = copyButtonHtml({
    label: "Copy file contents",
    copyText: "",
    disabled: true,
    attributesHtml: 'data-file-editor-target="copyButton"',
  });
  return `<span class="button-group" role="group" aria-label="Actions for selected file">
    ${copyButton}
    <a class="button secondary icon-only" href="${escapeHtml(contentUrl)}" download="${escapeHtml(name)}" data-turbo="false" title="Download file" aria-label="Download file"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg></a>
    <form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/file-browser/delete" data-turbo-stream="true" data-turbo-confirm="Delete ${escapeHtml(name)}? This cannot be undone.">
      <input type="hidden" name="path" value="${escapeHtml(path)}"><input type="hidden" name="filesView" value="${escapeHtml(view.id)}">
      <button class="button danger icon-only" type="submit" title="Delete file" aria-label="Delete file">${Icons.Trash}</button>
    </form>
  </span>`;
}

function renderEntryRow(workspaceId: string, viewId: string, entry: FileEntry, expanded: boolean, selectedPath?: string): string {
  const icon = entry.kind === "directory"
    ? `${Icons.Disclosure}<span class="status-spinner sm files-directory-spinner"></span>`
    : entry.kind === "symlink" ? "↗" : "";
  const destination = entry.kind === "directory"
    ? `href="${escapeHtml(directoryToggleUrl(workspaceId, viewId, entry.path, !expanded))}" data-turbo-frame="${filesDirectoryFrameId(workspaceId, viewId, entry.path)}"`
    : entry.openable
      ? `href="${escapeHtml(workspaceFileOpenUrl(workspaceId, entry.path, {}, viewId))}" data-turbo-stream="true" data-action="files-view#selectFile"`
      : "";
  const directoryAttributes = entry.kind === "directory"
    ? ` data-files-destination="${escapeHtml(entry.directoryPath ?? entry.path)}" data-action="dragenter->files#folderDragEnter dragover->files#folderDragOver dragleave->files#folderDragLeave drop->files#folderDrop" aria-expanded="${expanded}"`
    : "";
  const selectedAttribute = entry.path === selectedPath ? ' aria-selected="true"' : "";
  const size = entry.kind === "directory" ? "" : `<span class="files-row-size">${formatSize(entry.size)}</span>`;
  return actionItemHtml({
    kind: "single",
    primary: Boolean(destination),
    leadingHtml: `<span class="files-row-icon" aria-hidden="true">${icon}</span>`,
    label: { kind: "text", text: entry.name, className: "files-row-name" },
    trailingHtml: size,
    element: {
      tag: destination ? "a" : "div",
      className: "files-row",
      attributesHtml: `role="treeitem" tabindex="-1" data-kind="${entry.kind}"${destination ? ` ${destination}` : ""}${directoryAttributes}${selectedAttribute}`,
    },
  });
}

function renderEntry(workspaceId: string, viewId: string, entry: FileEntry, selectedPath?: string): string {
  if (entry.kind === "directory") return renderFilesDirectoryFrame(workspaceId, viewId, entry, entry.children, selectedPath);
  return renderEntryRow(workspaceId, viewId, entry, false, selectedPath);
}

export function renderFilesDirectoryFrame(workspaceId: string, viewId: string, entry: FileEntry, entries?: FileEntry[], selectedPath?: string): string {
  const expanded = entries !== undefined;
  const children = expanded
    ? `<div class="files-directory-children action-list" role="group">${entries.map((child) => renderEntry(workspaceId, viewId, child, selectedPath)).join("") || '<p class="files-empty empty-state">This folder is empty</p>'}</div>`
    : "";
  return `<turbo-frame id="${filesDirectoryFrameId(workspaceId, viewId, entry.path)}" class="files-directory-frame action-list">${renderEntryRow(workspaceId, viewId, entry, expanded, selectedPath)}${children}</turbo-frame>`;
}

export function renderFilesTreeResultsFrame(workspaceId: string, viewId: string, entries: FileEntry[], selectedPath?: string, filtered = false): string {
  const empty = filtered ? "No matching files." : "This folder is empty";
  return `<turbo-frame id="${filesTreeResultsFrameId(workspaceId, viewId)}" class="files-tree-results">
    <div class="files-filter-loading" role="status"><span class="status-spinner sm" aria-hidden="true"></span>Filtering files…</div>
    <div class="files-tree action-list" role="tree" aria-label="${filtered ? "Matching files" : `Files in ${escapeHtml(workspaceRoot)}`}" tabindex="0">${entries.map((entry) => renderEntry(workspaceId, viewId, entry, selectedPath)).join("") || `<p class="files-empty empty-state">${empty}</p>`}</div>
  </turbo-frame>`;
}

export function renderFilesTreeFrame(workspaceId: string, viewId: string, entries: FileEntry[], selectedPath?: string): string {
  const resultsFrameId = filesTreeResultsFrameId(workspaceId, viewId);
  return `<turbo-frame id="${filesTreeFrameId(workspaceId, viewId)}" class="files-frame">
    <div class="files-browser" data-controller="files" data-files-path-value="${escapeHtml(workspaceRoot)}" data-files-upload-url-value="/workspaces/${encodeURIComponent(workspaceId)}/file-browser/upload" data-action="dragenter->files#dragEnter dragover->files#dragOver dragleave->files#dragLeave drop->files#drop keydown->files#keydown">
      <form class="managed-list__filter files-filter" method="get" action="/workspaces/${encodeURIComponent(workspaceId)}/files" data-controller="server-filter" data-action="input->server-filter#submit" data-turbo-frame="${resultsFrameId}">
        <input type="hidden" name="filesView" value="${escapeHtml(viewId)}">
        <input class="text-field" type="search" name="q" placeholder="Filter files…" aria-label="Filter files by name" autocomplete="off">
      </form>
      ${renderFilesTreeResultsFrame(workspaceId, viewId, entries, selectedPath)}
      <div class="files-drop-overlay" aria-hidden="true"><strong>Drop files to upload</strong><span>${escapeHtml(workspaceRoot)}</span></div>
      <footer class="files-upload-status" hidden><div class="files-progress-track"><span data-files-target="progress"></span></div><span data-files-target="status">Uploading…</span><button class="button secondary" type="button" data-action="files#cancel">Cancel</button></footer>
    </div>
  </turbo-frame>`;
}

export function renderLazyFilesTreeFrame(workspaceId: string, view: FilesView): string {
  const query = new URLSearchParams({ filesView: view.id });
  return `<turbo-frame id="${filesTreeFrameId(workspaceId, view.id)}" class="files-frame" src="/workspaces/${encodeURIComponent(workspaceId)}/files?${query}" loading="lazy"><div class="files-loading"><span class="status-spinner"></span> Loading files…</div></turbo-frame>`;
}

export function renderFilesEditorFrame(workspaceId: string, view: FilesView): string {
  const frameId = filesEditorFrameId(workspaceId, view.id);
  if (!view.path) return `<turbo-frame id="${frameId}" class="files-editor-frame"><section class="file-editor-pane files-editor-empty"><header class="file-editor-toolbar work-view-toolbar"><span class="file-editor-path">Choose a file</span>${filesPaneToggle("expand")}</header><p>Select a file from the Files pane.</p></section></turbo-frame>`;
  const contentUrl = `/workspaces/${encodeURIComponent(workspaceId)}/files-view/content?${new URLSearchParams({ path: view.path })}`;
  const markdown = /\.(?:md|markdown)$/i.test(view.path);
  return `<turbo-frame id="${frameId}" class="files-editor-frame"><section class="file-editor-pane" data-controller="file-editor" data-file-editor-workspace-id-value="${escapeHtml(workspaceId)}" data-file-editor-path-value="${escapeHtml(view.path)}" data-file-editor-content-url-value="${escapeHtml(contentUrl)}" data-file-editor-line-value="${view.line ?? 0}" data-file-editor-column-value="${view.column ?? 0}">
    <header class="file-editor-toolbar work-view-toolbar"><span class="file-editor-path" title="${escapeHtml(view.path)}">${escapeHtml(view.path)}</span><span class="file-editor-toolbar-actions">${markdown ? `<span class="text-toggle" role="group" aria-label="Markdown display"><button class="text-toggle__option" type="button" data-file-editor-target="previewOption" data-action="file-editor#selectPreviewMode" data-preview-mode="edit" aria-pressed="true">Edit</button><button class="text-toggle__option" type="button" data-file-editor-target="previewOption" data-action="file-editor#selectPreviewMode" data-preview-mode="preview" aria-pressed="false">Rendered</button></span>` : ""}<span class="file-editor-status" data-file-editor-target="status">Loading…</span>${selectedFileActions(workspaceId, view)}${filesPaneToggle("expand")}</span></header>
    <div class="file-editor-host" data-file-editor-target="host"><div class="file-editor-loading" data-file-editor-target="loading" role="status"><i class="status-spinner sm" aria-hidden="true"></i><span>Loading file…</span></div></div>
    ${markdown ? `<div class="file-editor-preview agent-md" data-file-editor-target="preview" hidden></div>` : ""}
    <dialog class="dialog dialog--compact file-editor-conflict" data-file-editor-target="conflict"><form class="dialog__form" method="dialog"><header class="dialog__header"><strong>File changed on disk</strong></header><div class="dialog__body"><p>Choose which version should remain.</p></div><footer class="dialog__actions"><button class="button secondary" type="button" data-action="file-editor#useTheirs">Use theirs</button><button class="button primary" type="button" data-action="file-editor#useMine">Use mine</button></footer></form></dialog>
  </section></turbo-frame>`;
}

export function filesWorkViewPresentation(view: FilesView): WorkspaceWorkViewPresentation {
  return {
    sourceKey: `files:${view.id}`,
    label: view.path ? posix.basename(view.path) : "Files",
    reference: { type: "files", id: view.id },
    kind: "contextual",
    initiallyOpen: view.id !== defaultFilesViewId,
    availability: { phase: "live" },
  };
}

export function renderFilesWorkViewBody(workspaceId: string, view: FilesView): string {
  return `<section class="work-view-pane files-work-view"><div class="files-workbench${view.path ? "" : " is-files-pane-open"}" data-controller="files-view">
    <div class="files-editor-canvas">${renderFilesEditorFrame(workspaceId, view)}</div>
    <aside class="files-navigator" aria-label="Files"><header class="files-navigator-header work-view-toolbar"><span class="files-navigator-path">${escapeHtml(workspaceRoot)}</span>${filesPaneToggle("collapse")}</header>${renderLazyFilesTreeFrame(workspaceId, view)}</aside>
  </div></section>`;
}
