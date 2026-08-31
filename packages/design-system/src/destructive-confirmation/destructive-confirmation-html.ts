import { escapeHtml } from "@atelier/shared";

export interface DestructiveConfirmationOptions {
  /** Trusted HTML for the initial type="button" trigger. */
  buttonHtml: string;
  confirmCaption: string;
  cancelCaption: string;
  variant?: "primary" | "danger";
}

/** Renders an inline confirmation whose confirm action preserves native form submission. */
export function destructiveConfirmationHtml(options: DestructiveConfirmationOptions): string {
  return `<div class="destructive-confirmation"><div class="destructive-confirmation__trigger">${options.buttonHtml}</div><div class="destructive-confirmation__decision" inert><button class="button ${options.variant ?? "danger"} destructive-confirmation__action" type="submit">${escapeHtml(options.confirmCaption)}</button><button class="button secondary destructive-confirmation__cancel" type="button">${escapeHtml(options.cancelCaption)}</button></div></div>`;
}
