import { escapeHtml } from "@atelier/shared";
import { type HtmlContent } from "../html.ts";
import { perimeterButtonHtml } from "../perimeter-button/perimeter-button-html.ts";

export type ActivityButtonContent = HtmlContent;
export type ActivityButtonState = "initial" | "active";
export type ActivityButtonVariant = "primary" | "secondary" | "danger";

interface ActivityButtonBase {
  initialContent: ActivityButtonContent;
  activeContent: ActivityButtonContent;
  state: ActivityButtonState;
  variant: ActivityButtonVariant;
  /** Caller-owned attributes. Do not supply activity state, aria-busy, title, or aria-label attributes here. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  id?: string;
}

export type ActivityButtonOptions = ActivityButtonBase & (
  | { iconOnly: true; label: string }
  | { iconOnly?: false; label?: never }
);

/**
 * Renders a long-running action which remains available to stop or cancel the
 * active operation. Both states participate in sizing, so captions do not shift.
 */
export function activityButtonHtml(options: ActivityButtonOptions): string {
  const ownedAttributes = [
    options.state === "active" ? 'aria-busy="true"' : undefined,
    options.iconOnly ? `title="${escapeHtml(options.label)}" aria-label="${escapeHtml(options.label)}"` : undefined,
  ].filter(Boolean).join(" ");

  return perimeterButtonHtml({
    component: "activity-button",
    state: options.state,
    states: [
      { name: "initial", content: options.initialContent },
      { name: "active", content: options.activeContent },
    ],
    className: `${options.variant}${options.iconOnly ? " icon-only" : ""}`,
    attributesHtml: options.attributesHtml,
    ownedAttributesHtml: ownedAttributes,
    type: options.type,
    disabled: options.disabled,
    id: options.id,
  });
}
