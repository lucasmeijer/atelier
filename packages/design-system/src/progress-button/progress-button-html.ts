import { escapeHtml } from "@atelier/shared";

export type ProgressButtonContent =
  | { kind: "text"; text: string }
  /** Trusted, already-escaped HTML rendered inside the button. */
  | { kind: "html"; html: string };

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

function contentValue(content: ProgressButtonContent): string {
  return content.kind === "text" ? escapeHtml(content.text) : content.html;
}

function attributesHtml(value?: string): string {
  const attributes = value?.trim();
  return attributes ? ` ${attributes}` : "";
}

function stateContent(kind: "initial" | "in-progress", content: ProgressButtonContent): string {
  return `<span class="progress-button__content" data-progress-content="${kind}">${contentValue(content)}</span>`;
}

/**
 * Renders a long-running action whose perimeter communicates progress.
 *
 * In-progress buttons are always disabled: use an activity control instead when
 * the active control must remain available to stop or cancel the operation.
 * Omitting progress renders an indeterminate perimeter.
 */
export function progressButtonHtml(options: ProgressButtonOptions): string {
  if (options.state === "in-progress" && options.progress !== undefined && (!Number.isFinite(options.progress) || options.progress < 0 || options.progress > 100)) {
    throw new RangeError("Progress button progress must be between 0 and 100");
  }

  const className = escapeHtml(["button", options.className, "progress-button"].filter(Boolean).join(" "));
  const id = options.id ? ` id="${escapeHtml(options.id)}"` : "";
  const inProgress = options.state === "in-progress";
  const disabled = options.disabled || inProgress ? " disabled" : "";
  const busy = inProgress ? ' aria-busy="true"' : "";
  const progressKind = inProgress && options.progress === undefined ? ' data-progress-kind="indeterminate"' : "";
  const progressStyle = inProgress && options.progress !== undefined ? ` style="--button-progress:${options.progress}"` : "";

  return `<button${id} class="${className}" type="${options.type ?? "button"}" data-progress-state="${options.state}"${progressKind}${progressStyle}${attributesHtml(options.attributesHtml)}${disabled}${busy}><svg class="progress-button__perimeter" aria-hidden="true"><rect pathLength="100"/></svg>${stateContent("initial", options.initialContent)}${stateContent("in-progress", options.progressContent)}</button>`;
}
