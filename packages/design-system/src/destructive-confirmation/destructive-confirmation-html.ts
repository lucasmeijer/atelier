import { escapeHtml } from "@atelier/shared";
import { buttonHtml, type ButtonOptions } from "../button/button-html.ts";
import { buttonContentHtml, buttonPresentation } from "../button/button-content.ts";
import { attributesHtml } from "../html.ts";
import { Icons } from "../icons/icons-html.ts";

export interface DestructiveConfirmationOptions {
  /** Initial control which arms the confirmation. Must be type="button". */
  trigger: Omit<ButtonOptions, "type"> & { type: "button" };
  confirmCaption: string;
  cancelCaption: string;
  confirmFormAction?: string;
}

/** Keeps the opt-out in place and the native submit button in the top layer. */
export function destructiveConfirmationHtml(options: DestructiveConfirmationOptions): string {
  const { trigger } = options;
  const presentation = buttonPresentation(trigger.variant, trigger.content);
  const cancelContent = buttonContentHtml(trigger.content.kind === "icon-only"
    ? { kind: "icon-only", iconHtml: Icons.Close, label: options.cancelCaption }
    : { kind: "caption", caption: options.cancelCaption });
  const triggerButton = `<button class="${presentation.className} destructive-confirmation__trigger" type="button"${presentation.accessibilityHtml}${trigger.disabled ? " disabled" : ""}${attributesHtml(trigger.attributesHtml)}>${presentation.contentHtml}<span class="destructive-confirmation__cancel" aria-hidden="true">${cancelContent}</span></button>`;
  const confirmButton = buttonHtml({
    type: "submit",
    variant: trigger.variant,
    content: { kind: "caption", caption: options.confirmCaption },
    attributesHtml: options.confirmFormAction === undefined ? undefined : `formaction="${escapeHtml(options.confirmFormAction)}"`,
  });
  return `<div class="destructive-confirmation" data-controller="destructive-confirmation" data-destructive-confirmation-cancel-caption="${escapeHtml(options.cancelCaption)}">${triggerButton}<div class="destructive-confirmation__confirm" popover="auto">${confirmButton}</div></div>`;
}
