import { escapeHtml } from "@atelier/shared";
import { attributesHtml, classNames } from "../html.ts";

export interface ActionItemElement {
  tag: "a" | "button" | "div" | "span" | "summary";
  /** Caller-owned attributes. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
}

interface ActionItemLabelOptions {
  /** Caller-owned label attributes. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
  /** Caller-owned scrolling-text attributes. Attribute values containing external input must be escaped. */
  textAttributesHtml?: string;
}

export type ActionItemLabel = ActionItemLabelOptions & { kind: "text"; text: string };

interface ActionItemContent {
  label: ActionItemLabel;
  /** Trusted HTML before the label, such as an icon or disclosure indicator. */
  leadingHtml?: string;
  /** Trusted HTML after the label but within the primary action, such as status or metadata. */
  trailingHtml?: string;
  /** Plain-text secondary explanation, rendered with canonical two-line anatomy. */
  description?: string;
  tone?: "default" | "danger";
}

interface SingleActionItemOptions extends ActionItemContent {
  kind: "single";
  element: ActionItemElement;
  /** Most action items are their own primary action. Set false for semantic rows such as treeitems. */
  primary?: boolean;
}

interface CompoundActionItemOptions extends ActionItemContent {
  kind: "compound";
  container?: Omit<ActionItemElement, "tag">;
  primary: ActionItemElement;
  /** Trusted controls revealed while the item is hovered, focused, active, or selected. */
  engagedActionsHtml?: string;
}

export type ActionItemOptions = SingleActionItemOptions | CompoundActionItemOptions;

function elementHtml(element: ActionItemElement, className: string, content: string): string {
  return `<${element.tag} class="${escapeHtml(className)}"${attributesHtml(element.attributesHtml)}>${content}</${element.tag}>`;
}

function labelHtml(label: ActionItemLabel): string {
  return `<span class="${escapeHtml("action-item__label")}"${attributesHtml(label.attributesHtml)}><span class="action-item__label-text"${attributesHtml(label.textAttributesHtml)}>${escapeHtml(label.text)}</span></span>`;
}

function contentHtml(options: ActionItemContent): string {
  return `${options.leadingHtml ? `<span class="action-item__icon">${options.leadingHtml}</span>` : ""}<span class="action-item__content">${labelHtml(options.label)}${options.description ? `<span class="action-item__description">${escapeHtml(options.description)}</span>` : ""}</span>${options.trailingHtml ? `<span class="action-item__metadata">${options.trailingHtml}</span>` : ""}`;
}

/** Renders the canonical action-item markup shared by SSR and browser-created UI. */
export function actionItemHtml(options: ActionItemOptions): string {
  const content = contentHtml(options);
  if (options.kind === "single") {
    return elementHtml(options.element, classNames("action-item", options.tone === "danger" && "is-danger", options.primary === false ? undefined : "action-item__primary"), content);
  }

  const primary = elementHtml(options.primary, "action-item__primary", content);
  const actions = options.engagedActionsHtml ? `<div class="action-item__actions action-item__actions--engaged">${options.engagedActionsHtml}</div>` : "";
  const container = options.container ?? {};
  return `<div class="${escapeHtml(classNames("action-item", options.tone === "danger" && "is-danger"))}"${attributesHtml(container.attributesHtml)}>${primary}${actions}</div>`;
}

/** Parses an action item for browser-only UI that needs to attach imperative listeners. */
export function actionItemElement<T extends HTMLElement = HTMLElement>(options: ActionItemOptions): T {
  const template = document.createElement("template");
  template.innerHTML = actionItemHtml(options);
  const element = template.content.firstElementChild;
  if (!(element instanceof HTMLElement)) throw new Error("Action item renderer did not produce an HTML element");
  // SAFETY: The caller chooses T to match the element tag supplied in the same options object.
  return element as T;
}
