import { escapeHtml } from "@atelier/shared";
import { destructiveConfirmationHtml } from "../destructive-confirmation/destructive-confirmation-html.ts";
import { Icons } from "../icons/icons-html.ts";

export interface WarningBannerOptions {
  title: string;
  message?: string;
  actionsHtml?: string;
  /** The feature owns dismissal persistence and supplies a POST endpoint. */
  dismiss?: { action: string; state: string };
}

/** A persistent warning with optional actions and an explicitly confirmed dismissal. */
export function warningBannerHtml(options: WarningBannerOptions): string {
  const dismiss = options.dismiss ? `<form method="post" action="${escapeHtml(options.dismiss.action)}" data-turbo="true"><input type="hidden" name="state" value="${escapeHtml(options.dismiss.state)}">${destructiveConfirmationHtml({
    trigger: { type: "button", variant: "danger", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Dismiss warning" } },
    confirmCaption: "Yes, clear this warning", cancelCaption: "Never mind",
  })}</form>` : "";
  return `<aside class="warning-banner" role="status"><div class="warning-banner__header"><strong>${escapeHtml(options.title)}</strong>${dismiss}</div>${options.message || options.actionsHtml ? `<div class="warning-banner__body">${options.message ? `<p>${escapeHtml(options.message)}</p>` : ""}${options.actionsHtml ? `<div class="warning-banner__actions">${options.actionsHtml}</div>` : ""}</div>` : ""}</aside>`;
}
