import { escapeHtml } from "@atelier/shared";
import { attributesHtml, htmlContent } from "../html.ts";
import type { TransientFeedbackOptions } from "./transient-feedback-html.ts";

export function transientFeedbackMarkup(options: TransientFeedbackOptions, className: string): string {
  const { element } = options;
  const contentTag = element.tag === "button" ? "span" : "div";
  const initialHidden = options.state === "feedback" ? " hidden" : "";
  const feedbackHidden = options.state === "initial" ? " hidden" : "";
  const keepEnabled = options.keepEnabledDuringFeedback ? " data-transient-feedback-keep-enabled" : "";
  const disabled = element.tag === "button" && options.state === "feedback" && !options.keepEnabledDuringFeedback ? " disabled" : "";

  return `<${element.tag} class="${escapeHtml(className)}" data-controller="transient-feedback" data-transient-feedback-state-value="${options.state}"${keepEnabled}${attributesHtml(element.attributesHtml)}${disabled}><${contentTag} class="transient-feedback__content" data-transient-feedback-content="initial"${initialHidden}>${htmlContent(options.initialContent)}</${contentTag}><${contentTag} class="transient-feedback__content" data-transient-feedback-content="feedback" role="status"${feedbackHidden}>${htmlContent(options.feedbackContent)}</${contentTag}></${element.tag}>`;
}
