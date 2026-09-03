import { escapeHtml } from "@atelier/shared";
import { classNames } from "../html.ts";

export type ButtonVariant = "primary" | "secondary" | "danger";

export type ButtonContent =
  | { kind: "caption"; caption: string }
  | { kind: "icon-only"; iconHtml: string; label: string };

export function buttonContentHtml(content: ButtonContent): string {
  if (content.kind === "caption") return `<span class="button__caption">${escapeHtml(content.caption)}</span>`;
  return `<span class="button__icon" aria-hidden="true">${content.iconHtml}</span>`;
}

interface ButtonPresentation {
  className: string;
  accessibilityHtml: string;
  contentHtml: string;
}

export function buttonPresentation(variant: ButtonVariant, content: ButtonContent): ButtonPresentation {
  const iconOnlyLabel = content.kind === "icon-only" ? escapeHtml(content.label) : undefined;
  return {
    className: classNames("button", variant, content.kind === "icon-only" && "icon-only"),
    accessibilityHtml: iconOnlyLabel === undefined ? "" : ` title="${iconOnlyLabel}" aria-label="${iconOnlyLabel}"`,
    contentHtml: buttonContentHtml(content),
  };
}
