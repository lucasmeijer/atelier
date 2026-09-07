import { escapeHtml } from "@atelier/shared";
import { attributesHtml } from "../html.ts";
import { buttonPresentation, type ButtonContent, type ButtonVariant } from "../button/button-content.ts";

export interface ActionLinkOptions {
  href: string;
  variant: ButtonVariant;
  content: ButtonContent;
  /** Icon-only: two 0–100 values on one clockwise ring. Shared arc is neutral;
   * reference beyond value is green; value beyond reference is red. A dim full-circle
   * track preserves the button outline, including at zero. Does not imply busy. */
  perimeterComparison?: { referencePercent: number; valuePercent: number };
  /**
   * Caller-owned integration attributes. Do not supply class, href, title, or
   * aria-label here. Attribute values containing external input must be escaped.
   */
  attributesHtml?: string;
}

/** Both arcs begin at twelve o'clock. SVG sweep flag 1 always runs clockwise. */
function clockwiseArc(percent: number): string {
  if (percent === 0) return "";
  if (percent === 100) return "M14 1 A13 13 0 0 1 14 27 A13 13 0 0 1 14 1";
  const angle = (percent / 100 * 360 - 90) * Math.PI / 180;
  return `M14 1 A13 13 0 ${percent > 50 ? 1 : 0} 1 ${(14 + 13 * Math.cos(angle)).toFixed(4)} ${(14 + 13 * Math.sin(angle)).toFixed(4)}`;
}

/** Renders a native link using the canonical prominent-action treatment. */
export function actionLinkHtml(options: ActionLinkOptions): string {
  const presentation = buttonPresentation(options.variant, options.content);
  const comparison = options.perimeterComparison;
  if (comparison && options.content.kind !== "icon-only") throw new Error("A comparison ring requires an icon-only link");
  if (comparison && Object.values(comparison).some((value) => !Number.isFinite(value) || value < 0 || value > 100)) throw new RangeError("Link comparison percentages must be between 0 and 100");
  const perimeter = comparison ? `<svg class="action-link__perimeter" viewBox="0 0 28 28" aria-hidden="true"><path class="action-link__track" d="${clockwiseArc(100)}"/><path class="action-link__reference" d="${clockwiseArc(comparison.referencePercent)}"/><path class="action-link__value" d="${clockwiseArc(comparison.valuePercent)}"/><path class="action-link__shared" d="${clockwiseArc(Math.min(comparison.referencePercent, comparison.valuePercent))}"/></svg>` : "";
  return `<a class="${presentation.className}${comparison ? " action-link--comparison" : ""}" href="${escapeHtml(options.href)}"${presentation.accessibilityHtml}${attributesHtml(options.attributesHtml)}>${perimeter}${presentation.contentHtml}</a>`;
}
