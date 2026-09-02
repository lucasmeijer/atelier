import { escapeHtml } from "@atelier/shared";
import { buttonHtml, type ButtonOptions } from "../button/button-html.ts";

export interface DestructiveConfirmationOptions {
  /** Initial control which arms the confirmation. Must be type="button". */
  trigger: Omit<ButtonOptions, "type"> & { type: "button" };
  confirmCaption: string;
  cancelCaption: string;
  confirmFormAction?: string;
}

/** Renders an inline confirmation whose confirm action preserves native form submission. */
export function destructiveConfirmationHtml(options: DestructiveConfirmationOptions): string {
  const triggerButton = buttonHtml(options.trigger);
  const formAction = options.confirmFormAction === undefined ? "" : ` formaction="${escapeHtml(options.confirmFormAction)}"`;
  const confirmButton = buttonHtml({
    type: "submit",
    variant: options.trigger.variant,
    content: { kind: "caption", caption: options.confirmCaption },
    attributesHtml: `data-destructive-confirmation-action${formAction}`,
  });
  const cancelButton = buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "caption", caption: options.cancelCaption },
    attributesHtml: "data-destructive-confirmation-cancel",
  });
  return `<div class="destructive-confirmation" data-controller="destructive-confirmation"><div class="destructive-confirmation__trigger">${triggerButton}</div><div class="destructive-confirmation__decision" inert>${confirmButton}${cancelButton}</div></div>`;
}
