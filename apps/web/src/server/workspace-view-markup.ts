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

export function fullscreenViewAttributes(key: string, title: string): string {
  return `data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="view" data-atelier-fullscreen-view-key-value="${escapeHtml(key)}" data-atelier-fullscreen-title-value="${escapeHtml(title)}"`;
}

export function selectorCloseForm(close: ViewCloseAction): string {
  const label = `Close ${close.label}`;
  const confirmation = destructiveConfirmationHtml({
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

export function workspacePreparationInvalidatedTurboStream(workspaceId: string, conversationId?: string): string {
  return behaviorTurboStream("invalidate-workspace-preparation", workspaceId, { "conversation-id": conversationId });
}
