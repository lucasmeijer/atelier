import { type HtmlContent } from "../html.ts";
import { perimeterButtonHtml } from "../perimeter-button/perimeter-button-html.ts";

export type ProgressButtonContent = HtmlContent;

interface ProgressButtonBase {
  initialContent: ProgressButtonContent;
  progressContent: ProgressButtonContent;
  /** Additional caller-owned classes, such as a button variant or `icon-only`. */
  className?: string;
  /** Caller-owned attributes. Do not supply state, progress, disabled, or aria-busy attributes here. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  id?: string;
}

export type ProgressButtonOptions =
  | (ProgressButtonBase & { state: "initial" })
  | (ProgressButtonBase & { state: "in-progress"; progress?: number });

/**
 * Renders a long-running action whose perimeter communicates progress.
 *
 * In-progress buttons are always disabled: use an activity button instead when
 * the active control must remain available to stop or cancel the operation.
 * Omitting progress renders an indeterminate perimeter.
 */
export function progressButtonHtml(options: ProgressButtonOptions): string {
  if (options.state === "in-progress" && options.progress !== undefined && (!Number.isFinite(options.progress) || options.progress < 0 || options.progress > 100)) {
    throw new RangeError("Progress button progress must be between 0 and 100");
  }

  const inProgress = options.state === "in-progress";
  const ownedAttributes = [
    inProgress && options.progress === undefined ? 'data-progress-kind="indeterminate"' : undefined,
    inProgress && options.progress !== undefined ? `style="--button-progress:${options.progress}"` : undefined,
    inProgress ? 'aria-busy="true"' : undefined,
  ].filter(Boolean).join(" ");

  return perimeterButtonHtml({
    component: "progress-button",
    state: options.state,
    states: [
      { name: "initial", content: options.initialContent },
      { name: "in-progress", content: options.progressContent },
    ],
    className: options.className,
    attributesHtml: options.attributesHtml,
    ownedAttributesHtml: ownedAttributes,
    type: options.type,
    disabled: options.disabled || inProgress,
    id: options.id,
  });
}
