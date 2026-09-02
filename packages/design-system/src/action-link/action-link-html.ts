import { escapeHtml } from "@atelier/shared";
import { attributesHtml } from "../html.ts";
import { buttonPresentation, type ButtonContent, type ButtonVariant } from "../button/button-content.ts";

export interface ActionLinkOptions {
  href: string;
  variant: ButtonVariant;
  content: ButtonContent;
  /**
   * Caller-owned integration attributes. Do not supply class, href, title, or
   * aria-label here. Attribute values containing external input must be escaped.
   */
  attributesHtml?: string;
}

/** Renders a native link using the canonical prominent-action treatment. */
export function actionLinkHtml(options: ActionLinkOptions): string {
  const presentation = buttonPresentation(options.variant, options.content);
  return `<a class="${presentation.className}" href="${escapeHtml(options.href)}"${presentation.accessibilityHtml}${attributesHtml(options.attributesHtml)}>${presentation.contentHtml}</a>`;
}
