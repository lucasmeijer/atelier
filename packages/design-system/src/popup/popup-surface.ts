import { escapeHtml } from "@atelier/shared";
import { attributesHtml, classNames } from "../html.ts";

export interface PopupMenuOptions {
  id: string;
  /** Accessible name for the menu. */
  label: string;
  /** Trusted, already-escaped menu contents, typically Action Items, forms, and separators. */
  contentHtml: string;
  /** Position relative to the caller's anchor. Omit for a caller-positioned surface. */
  placement?: "below" | "above";
  /** Caller-owned menu attributes. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
}

/** Renders a native popover menu surface. Its caller owns the invoking control. */
export function popupMenuHtml(options: PopupMenuOptions): string {
  const className = classNames("floating-surface", "popup-menu", "action-list", options.placement && "popup-menu-anchored", options.placement === "above" && "opens-above");
  return `<div class="${escapeHtml(className)}" id="${escapeHtml(options.id)}" role="menu" aria-label="${escapeHtml(options.label)}" popover="auto"${attributesHtml(options.attributesHtml)}>${options.contentHtml}</div>`;
}

