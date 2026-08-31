import { escapeHtml } from "@atelier/shared";
import { attributesHtml, classNames, htmlContent, type HtmlContent } from "../html.ts";

export type TransientFeedbackContent = HtmlContent;

interface TransientFeedbackElement {
  tag: "button" | "div";
  className?: string;
  /** Caller-owned attributes. Do not supply feedback state or controller attributes here. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
}

export interface TransientFeedbackOptions {
  element: TransientFeedbackElement;
  initialContent: TransientFeedbackContent;
  feedbackContent: TransientFeedbackContent;
  state: "initial" | "feedback";
}

/**
 * Renders content which briefly acknowledges a completed action before restoring
 * its initial content. Only the active content participates in layout.
 */
export function transientFeedbackHtml(options: TransientFeedbackOptions): string {
  const { element } = options;
  const className = escapeHtml(classNames(element.className, "transient-feedback"));
  const contentTag = element.tag === "button" ? "span" : "div";
  const initialHidden = options.state === "feedback" ? " hidden" : "";
  const feedbackHidden = options.state === "initial" ? " hidden" : "";
  const disabled = element.tag === "button" && options.state === "feedback" ? " disabled" : "";

  return `<${element.tag} class="${className}" data-controller="transient-feedback" data-transient-feedback-state-value="${options.state}"${attributesHtml(element.attributesHtml)}${disabled}><${contentTag} class="transient-feedback__content" data-transient-feedback-content="initial"${initialHidden}>${htmlContent(options.initialContent)}</${contentTag}><${contentTag} class="transient-feedback__content" data-transient-feedback-content="feedback" role="status"${feedbackHidden}>${htmlContent(options.feedbackContent)}</${contentTag}></${element.tag}>`;
}
