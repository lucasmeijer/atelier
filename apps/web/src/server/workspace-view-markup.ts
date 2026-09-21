import { buttonHtml } from "@atelier/design-system/button";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { Icons } from "@atelier/design-system/icons";
import { escapeHtml } from "@atelier/shared";
export interface ViewCloseAction {
  action: string;
  label: string;
}

export function barButton(label: string, action: string, iconHtml: string, attributes = ""): string {
  return buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml, label },
    attributesHtml: `data-action="${action}" ${attributes}`,
  });
}

/** Busy and attention are independent and share one indicator slot. */
export function busyAttentionIndicator(state: { busy?: boolean; requestingAttention?: boolean }, attributesHtml = ""): string {
  const label = [state.busy && "Busy", state.requestingAttention && "Requesting attention"].filter(Boolean).join("; ");
  return `<span class="status-indicator"${label ? ` role="img" aria-label="${label}"` : ""} ${attributesHtml}>${state.busy ? '<i class="status-spinner sm" aria-hidden="true"></i>' : ""}${state.requestingAttention ? '<i class="status-dot attention" aria-hidden="true"></i>' : ""}</span>`;
}

export function fullscreenViewAttributes(key: string, title: string): string {
  return `data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="view" data-atelier-fullscreen-view-key-value="${escapeHtml(key)}" data-atelier-fullscreen-title-value="${escapeHtml(title)}"`;
}

export function selectorCloseForm(close: ViewCloseAction): string {
  const label = `Close ${close.label}`;
  const confirmation = destructiveConfirmationHtml({
    id: `close_${close.action}`,
    trigger: { type: "button", variant: "danger", content: { kind: "icon-only", iconHtml: Icons.Close, label } },
    confirmCaption: "Yes, close",
    cancelCaption: "Oops",
  });
  return `<form data-turbo="true" method="post" action="${escapeHtml(close.action)}">${confirmation}</form>`;
}

export function behaviorTurboStream(action: string, workspaceId: string, attributes: Record<string, string | number | boolean | undefined> = {}): string {
  let data = "";
  for (const [name, value] of Object.entries({ "workspace-id": workspaceId, ...attributes })) {
    if (value !== undefined) data += ` data-${name}="${escapeHtml(String(value))}"`;
  }
  return `<turbo-stream action="${escapeHtml(action)}" target="workspace_detail"${data}></turbo-stream>`;
}
