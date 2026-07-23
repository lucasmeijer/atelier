import { domId, escapeHtml, type WorkspaceTabContribution } from "@atelier/shared";
import type { WorkspaceFileEditorTab } from "./state.ts";

export function workspaceFileEditorOpenUrl(workspaceId: string, path: string, position: { line?: number; column?: number } = {}): string {
  const query = new URLSearchParams({ path });
  if (position.line) query.set("line", String(position.line));
  if (position.column) query.set("column", String(position.column));
  return `/workspaces/${encodeURIComponent(workspaceId)}/file-editor/open?${query}`;
}

export function fileEditorSignalId(workspaceId: string): string {
  return domId("file_editor_signal", workspaceId);
}

export function renderFileEditorSignal(workspaceId: string, action: { tabKey?: string; line?: number; column?: number } = {}): string {
  const attributes = [
    `id="${fileEditorSignalId(workspaceId)}"`,
    `data-controller="file-editor-signal"`,
    `data-file-editor-signal-workspace-id-value="${escapeHtml(workspaceId)}"`,
    action.tabKey ? `data-file-editor-signal-tab-key-value="${escapeHtml(action.tabKey)}"` : "",
    action.line ? `data-file-editor-signal-line-value="${action.line}"` : "",
    action.column ? `data-file-editor-signal-column-value="${action.column}"` : "",
  ].filter(Boolean).join(" ");
  return `<span ${attributes} hidden></span>`;
}

export function renderFileEditorTab(workspaceId: string, tab: WorkspaceFileEditorTab, label: string): WorkspaceTabContribution {
  const contentUrl = `/workspaces/${encodeURIComponent(workspaceId)}/file-editor/content?${new URLSearchParams({ path: tab.path })}`;
  return {
    key: tab.key,
    label,
    paneHtml: `<section class="tab-pane file-editor-pane" data-tab-pane="${escapeHtml(tab.key)}" data-controller="file-editor" data-file-editor-workspace-id-value="${escapeHtml(workspaceId)}" data-file-editor-path-value="${escapeHtml(tab.path)}" data-file-editor-content-url-value="${escapeHtml(contentUrl)}" data-file-editor-line-value="${tab.line ?? 0}" data-file-editor-column-value="${tab.column ?? 0}">
      <header class="file-editor-toolbar"><span class="file-editor-path" title="${escapeHtml(tab.path)}">${escapeHtml(tab.path)}</span><span class="file-editor-status" data-file-editor-target="status">Loading…</span></header>
      <div class="file-editor-host" data-file-editor-target="host"></div>
      <dialog class="file-editor-conflict" data-file-editor-target="conflict"><form method="dialog"><strong>File changed on disk</strong><p>Choose which version should remain.</p><div><button type="button" data-action="file-editor#useTheirs">Use theirs</button><button class="primary" type="button" data-action="file-editor#useMine">Use mine</button></div></form></dialog>
    </section>`,
  };
}
