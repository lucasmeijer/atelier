import { buttonHtml } from "@atelier/design-system/button";
import { Icons } from "@atelier/design-system/icons";
import { escapeHtml, domId } from "@atelier/shared";

export function renderAttachmentChip(attachment: { id: string; name: string; size: number; isImage: boolean }, draftId: string): string {
  const chipId = domId("agent_draft_chip", draftId, attachment.id);
  const previewUrl = `/agent-attachment-drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachment.id)}`;
  const content = attachment.isImage
    ? buttonHtml({
      type: "button", variant: "secondary",
      content: { kind: "caption", caption: attachment.name, iconHtml: `<img class="agent-chip-thumbnail" src="${escapeHtml(previewUrl)}" alt="${escapeHtml(attachment.name)}">` },
      attributesHtml: `data-draft-image-preview aria-description="Open image preview" aria-haspopup="dialog" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="media" data-atelier-fullscreen-title-value="${escapeHtml(attachment.name)}" data-action="atelier-fullscreen#open"`,
    })
    : `<span class="agent-chip-ico">📄</span><span class="agent-chip-name">${escapeHtml(attachment.name)}</span>`;
  return `<span class="agent-chip" id="${chipId}">
    <input type="hidden" name="attachment" value="${escapeHtml(attachment.id)}">
    ${content}
    <span class="agent-chip-size">${formatBytes(attachment.size)}</span>
    ${buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: `Remove ${attachment.name}` }, attributesHtml: `data-action="agent-attachments#remove" data-attachment-id="${escapeHtml(attachment.id)}"` })}
  </span>`;
}

/** Keep the native picker and its Stimulus wiring together in both composers. */
export function renderAttachmentPicker(kind: "caption" | "icon-only" = "caption"): string {
  return `<input type="file" multiple hidden data-agent-attachments-target="file" data-action="change->agent-attachments#choose">
    ${buttonHtml({
      type: "button", variant: "secondary",
      content: kind === "caption"
        ? { kind, caption: "Attach files", iconHtml: Icons.Paperclip }
        : { kind, label: "Attach files", iconHtml: Icons.Paperclip },
      attributesHtml: `data-popular-button="${kind === "caption" ? "touch" : ""}" data-action="agent-attachments#openPicker"`,
    })}`;
}

function formatBytes(size: number): string {
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)} MB`;
  if (size >= 1000) return `${Math.round(size / 1000)} KB`;
  return `${size} B`;
}
