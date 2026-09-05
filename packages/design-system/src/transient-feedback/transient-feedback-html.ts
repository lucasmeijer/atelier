import { transientFeedbackMarkup } from "./transient-feedback-markup.ts";
import type { ButtonVariant } from "../button/button-html.ts";
import { classNames, type HtmlContent } from "../html.ts";

export type TransientFeedbackContent = HtmlContent;

type TransientFeedbackElement = ({ tag: "button"; variant?: ButtonVariant } | { tag: "div" }) & {
  /** Caller-owned attributes. Do not supply feedback state or controller attributes here. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
}

export interface TransientFeedbackOptions {
  element: TransientFeedbackElement;
  initialContent: TransientFeedbackContent;
  feedbackContent: TransientFeedbackContent;
  state: "initial" | "feedback";
  /** Keeps button controls interactive while their feedback content is visible. */
  keepEnabledDuringFeedback?: boolean;
}

/**
 * Renders content which briefly acknowledges a completed action before restoring
 * its initial content. Only the active content participates in layout.
 */
export function transientFeedbackHtml(options: TransientFeedbackOptions): string {
  return transientFeedbackMarkup(options, classNames("transient-feedback", options.element.tag === "button" && "button", options.element.tag === "button" && (options.element.variant ?? "secondary")));
}
