import { posix } from "node:path";
import { actionItemHtml } from "@atelier/design-system/action-item";
import { actionLinkHtml } from "@atelier/design-system/action-link";
import { buttonHtml } from "@atelier/design-system/button";
import { buttonGroupHtml } from "@atelier/design-system/button-group";
import { copyButtonHtml } from "@atelier/design-system/copy-button";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import { toggleHtml } from "@atelier/design-system/toggle";
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
  return buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml: Icons.Panel, label },
    attributesHtml: `${action === "expand" ? "data-files-pane-expand " : ""}data-action="files-view#${action}"`,
  });
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
  const downloadButton = actionLinkHtml({
    href: contentUrl,
    variant: "secondary",
    content: {
      kind: "icon-only",
      iconHtml: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
      label: "Download file",
    },
    attributesHtml: `download="${escapeHtml(name)}" data-turbo="false"`,
  });
  const deleteButton = buttonHtml({
    type: "submit",
    variant: "danger",
    content: { kind: "icon-only", iconHtml: Icons.Trash, label: "Delete file" },
  });
  const deleteForm = `<form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/file-browser/delete" data-turbo-stream="true" data-turbo-confirm="Delete ${escapeHtml(name)}? This cannot be undone.">
    <input type="hidden" name="path" value="${escapeHtml(path)}"><input type="hidden" name="filesView" value="${escapeHtml(view.id)}">
    ${deleteButton}
  </form>`;
  return buttonGroupHtml({
    orientation: "horizontal",
    semantics: "group",
    label: "Actions for selected file",
    itemsHtml: `${copyButton}${downloadButton}${deleteForm}`,
  });
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
    label: { kind: "text", text: entry.name },
    trailingHtml: size,
    element: {
      tag: destination ? "a" : "div",

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
  const cancelUploadButton = buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "caption", caption: "Cancel" },
    attributesHtml: 'data-action="files#cancel"',
  });
  return `<turbo-frame id="${filesTreeFrameId(workspaceId, viewId)}" class="files-frame">
    <div class="files-browser" data-controller="files" data-files-path-value="${escapeHtml(workspaceRoot)}" data-files-upload-url-value="/workspaces/${encodeURIComponent(workspaceId)}/file-browser/upload" data-action="dragenter->files#dragEnter dragover->files#dragOver dragleave->files#dragLeave drop->files#drop keydown->files#keydown">
      <form class="managed-list__filter files-filter" method="get" action="/workspaces/${encodeURIComponent(workspaceId)}/files" data-controller="server-filter" data-action="input->server-filter#submit" data-turbo-frame="${resultsFrameId}">
        <input type="hidden" name="filesView" value="${escapeHtml(viewId)}">
        <input class="text-field" type="search" name="q" placeholder="Filter files…" aria-label="Filter files by name" autocomplete="off">
      </form>
      ${renderFilesTreeResultsFrame(workspaceId, viewId, entries, selectedPath)}
      <div class="files-drop-overlay" aria-hidden="true"><strong>Drop files to upload</strong><span>${escapeHtml(workspaceRoot)}</span></div>
      <footer class="files-upload-status" hidden><div class="files-progress-track"><span data-files-target="progress"></span></div><span data-files-target="status">Uploading…</span>${cancelUploadButton}</footer>
    </div>
  </turbo-frame>`;
}

export function renderLazyFilesTreeFrame(workspaceId: string, view: FilesView): string {
  const query = new URLSearchParams({ filesView: view.id });
  return `<turbo-frame id="${filesTreeFrameId(workspaceId, view.id)}" class="files-frame" src="/workspaces/${encodeURIComponent(workspaceId)}/files?${query}" loading="lazy"><div class="files-loading"><span class="status-spinner"></span> Loading files…</div></turbo-frame>`;
}

function fileConflictDialog(): string {
  const useTheirsButton = buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "caption", caption: "Use theirs" },
    attributesHtml: 'data-action="file-editor#useTheirs"',
  });
  const useMineButton = buttonHtml({
    type: "button",
    variant: "primary",
    content: { kind: "caption", caption: "Use mine" },
    attributesHtml: 'data-action="file-editor#useMine"',
  });
  return dialogHtml({
    element: {

      attributesHtml: 'data-controller="dialog" data-file-editor-target="conflict"',
    },
    iconHtml: Icons.Files,
    titleCaption: "File changed on disk",
    bodyHtml: "Choose which version should remain.",
    footerHtml: `${useTheirsButton}${useMineButton}`,
    closeLabel: "Dismiss file conflict",
  });
}

function markdownDisplayToggle(): string {
  return toggleHtml({
    variant: "text",
    label: "Markdown display",
    name: "preview-mode",
    value: "edit",
    element: {
      tag: "span",
      dataAction: "change->file-editor#selectPreviewMode",
      data: { "file-editor-target": "previewOptions" },
    },
    options: [
      { label: "Edit", value: "edit" },
      { label: "Rendered", value: "preview" },
    ],
  });
}

export function renderFilesEditorFrame(workspaceId: string, view: FilesView): string {
  const frameId = filesEditorFrameId(workspaceId, view.id);
  if (!view.path) return `<turbo-frame id="${frameId}" class="files-editor-frame"><section class="file-editor-pane files-editor-empty"><header class="file-editor-toolbar work-view-toolbar"><span class="file-editor-path">Choose a file</span>${filesPaneToggle("expand")}</header><p>Select a file from the Files pane.</p></section></turbo-frame>`;
  const contentUrl = `/workspaces/${encodeURIComponent(workspaceId)}/files-view/content?${new URLSearchParams({ path: view.path })}`;
  const markdown = /\.(?:md|markdown)$/i.test(view.path);
  return `<turbo-frame id="${frameId}" class="files-editor-frame"><section class="file-editor-pane" data-controller="file-editor" data-file-editor-workspace-id-value="${escapeHtml(workspaceId)}" data-file-editor-path-value="${escapeHtml(view.path)}" data-file-editor-content-url-value="${escapeHtml(contentUrl)}" data-file-editor-line-value="${view.line ?? 0}" data-file-editor-column-value="${view.column ?? 0}">
    <header class="file-editor-toolbar work-view-toolbar"><span class="file-editor-path" title="${escapeHtml(view.path)}">${escapeHtml(view.path)}</span><span class="file-editor-toolbar-actions">${markdown ? markdownDisplayToggle() : ""}<span class="file-editor-status" data-file-editor-target="status">Loading…</span>${selectedFileActions(workspaceId, view)}${filesPaneToggle("expand")}</span></header>
    <div class="file-editor-host" data-file-editor-target="host"><div class="file-editor-loading" data-file-editor-target="loading" role="status"><i class="status-spinner sm" aria-hidden="true"></i><span>Loading file…</span></div></div>
    ${markdown ? `<div class="file-editor-preview agent-md" data-file-editor-target="preview" hidden></div>` : ""}
    ${fileConflictDialog()}
  </section></turbo-frame>`;
}

export function filesWorkViewPresentation(view: FilesView): WorkspaceWorkViewPresentation {
  return {
    sourceKey: `files:${view.id}`,
    label: view.path ? posix.basename(view.path) : "Files",
    reference: { type: "files", id: view.id },
    kind: "contextual", iconHtml: Icons.Files,
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
