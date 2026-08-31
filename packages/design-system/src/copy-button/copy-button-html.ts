import { escapeHtml } from "@atelier/shared";
import { classNames } from "../html.ts";
import { transientFeedbackHtml } from "../transient-feedback/transient-feedback-html.ts";

interface CopyButtonOptions {
  label: string;
  caption?: string;
  copyText?: string;
  disabled?: boolean;
  /** Caller-owned attributes. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
}

/** Renders the canonical clipboard action with shared success feedback. */
export function copyButtonHtml(options: CopyButtonOptions): string {
  const attributes = [
    'type="button"',
    `title="${escapeHtml(options.label)}"`,
    `aria-label="${escapeHtml(options.label)}"`,
    `data-transient-feedback-initial-label="${escapeHtml(options.label)}"`,
    'data-transient-feedback-feedback-label="Copied to clipboard"',
    options.copyText === undefined ? undefined : `data-copy-text="${escapeHtml(options.copyText)}"`,
    options.attributesHtml,
    options.disabled ? "disabled" : undefined,
  ].filter(Boolean).join(" ");
  const caption = options.caption === undefined ? "" : `<span>${escapeHtml(options.caption)}</span>`;

  return transientFeedbackHtml({
    element: {
      tag: "button",
      className: classNames("button secondary", options.caption === undefined && "icon-only", "copy-button"),
      attributesHtml: attributes,
    },
    initialContent: { kind: "html", html: `<span class="copy-button__icon" aria-hidden="true">⧉</span>${caption}` },
    feedbackContent: { kind: "html", html: '<span class="copy-button__icon" aria-hidden="true">✓</span>' },
    state: "initial",
  });
}
