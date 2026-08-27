import { domId, escapeHtml, type WorkspaceWorkViewPresentation } from "@atelier/shared";
import type { WorkspaceFileEditorView } from "./state.ts";

export function fileEditorSignalId(workspaceId: string): string {
  return domId("file_editor_signal", workspaceId);
}

export function renderFileEditorSignal(workspaceId: string, action: { viewKey?: string; line?: number; column?: number } = {}): string {
  const attributes = [
    `id="${fileEditorSignalId(workspaceId)}"`,
    `data-controller="file-editor-signal"`,
    `data-file-editor-signal-workspace-id-value="${escapeHtml(workspaceId)}"`,
    action.viewKey ? `data-file-editor-signal-view-key-value="${escapeHtml(action.viewKey)}"` : "",
    action.line ? `data-file-editor-signal-line-value="${action.line}"` : "",
    action.column ? `data-file-editor-signal-column-value="${action.column}"` : "",
  ].filter(Boolean).join(" ");
  return `<span ${attributes} hidden></span>`;
}

export function renderFileWorkView(workspaceId: string, view: WorkspaceFileEditorView, label: string): WorkspaceWorkViewPresentation {
  const contentUrl = `/workspaces/${encodeURIComponent(workspaceId)}/file-editor/content?${new URLSearchParams({ path: view.path })}`;
  const markdown = /\.(?:md|markdown)$/i.test(view.path);
  return {
    sourceKey: view.key,
    label,
    reference: { type: "file", path: view.path },
    kind: "resource",
    availability: { phase: "live" },
    bodyHtml: `<section class="work-view-pane file-editor-pane" data-work-view-source="${escapeHtml(view.key)}" data-controller="file-editor" data-file-editor-workspace-id-value="${escapeHtml(workspaceId)}" data-file-editor-path-value="${escapeHtml(view.path)}" data-file-editor-content-url-value="${escapeHtml(contentUrl)}" data-file-editor-line-value="${view.line ?? 0}" data-file-editor-column-value="${view.column ?? 0}">
      <header class="file-editor-toolbar"><span class="file-editor-path" title="${escapeHtml(view.path)}">${escapeHtml(view.path)}</span><span class="file-editor-toolbar-actions">${markdown ? `<span class="toggle" role="group" aria-label="Markdown display"><button class="toggle__option" type="button" data-file-editor-target="previewOption" data-action="file-editor#selectPreviewMode" data-preview-mode="edit" aria-pressed="true">Edit</button><button class="toggle__option" type="button" data-file-editor-target="previewOption" data-action="file-editor#selectPreviewMode" data-preview-mode="preview" aria-pressed="false">Preview</button></span>` : ""}<span class="file-editor-status" data-file-editor-target="status">Loading…</span></span></header>
      <div class="file-editor-host" data-file-editor-target="host"><div class="file-editor-loading" data-file-editor-target="loading" role="status"><i class="status-spinner sm" aria-hidden="true"></i><span>Loading file…</span></div></div>
      ${markdown ? `<div class="file-editor-preview agent-md" data-file-editor-target="preview" hidden></div>` : ""}
      <dialog class="file-editor-conflict" data-file-editor-target="conflict"><form method="dialog"><strong>File changed on disk</strong><p>Choose which version should remain.</p><div><button class="button secondary" type="button" data-action="file-editor#useTheirs">Use theirs</button><button class="button primary" type="button" data-action="file-editor#useMine">Use mine</button></div></form></dialog>
    </section>`,
  };
}
