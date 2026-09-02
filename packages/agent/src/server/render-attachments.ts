import { escapeHtml } from "./html.ts";
import { ids } from "./render-context.ts";

export function renderAttachmentChip(attachment: { id: string; name: string; size: number; isImage: boolean }, draftId: string): string {
  const chipId = ids.draftChip(draftId, attachment.id);
  return `<span class="agent-chip" id="${chipId}">
    <input type="hidden" name="attachment" value="${escapeHtml(attachment.id)}">
    <span class="agent-chip-ico">${attachment.isImage ? "🖼" : "📄"}</span>
    <span class="agent-chip-name">${escapeHtml(attachment.name)}</span>
    <span class="agent-chip-size">${formatBytes(attachment.size)}</span>
    <button type="button" class="agent-chip-x" data-action="agent-attachments#remove" data-attachment-id="${escapeHtml(attachment.id)}" data-chip-id="${chipId}">✕</button>
  </span>`;
}

export function renderNotice(level: "info" | "error", message: string): string {
  return `<div class="agent-noticeline ${escapeHtml(level)}" data-controller="agent-notice">${escapeHtml(message)}</div>`;
}

function formatBytes(size: number): string {
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)} MB`;
  if (size >= 1000) return `${Math.round(size / 1000)} KB`;
  return `${size} B`;
}
