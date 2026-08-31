import { escapeHtml } from "@atelier/shared";

export interface ActionItemElement {
  tag: "a" | "button" | "div" | "span" | "summary";
  className?: string;
  /** Caller-owned attributes. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
}

interface ActionItemLabelOptions {
  className?: string;
  /** Caller-owned label attributes. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
  /** Caller-owned scrolling-text attributes. Attribute values containing external input must be escaped. */
  textAttributesHtml?: string;
}

export type ActionItemLabel = ActionItemLabelOptions & (
  | { kind: "text"; text: string }
  /** Trusted, already-escaped HTML rendered inside the scrolling label text. */
  | { kind: "html"; html: string }
);

interface ActionItemContent {
  label?: ActionItemLabel;
  /** Trusted HTML before the label, such as an icon or disclosure indicator. */
  leadingHtml?: string;
  /** Trusted HTML after the label but within the primary action, such as status or metadata. */
  trailingHtml?: string;
  /** Trusted primary content for exceptional structures which cannot use the canonical label. */
  contentHtml?: string;
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

function classes(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

function attributesHtml(value?: string): string {
  const attributes = value?.trim();
  return attributes ? ` ${attributes}` : "";
}

function elementHtml(element: ActionItemElement, className: string, content: string): string {
  return `<${element.tag} class="${escapeHtml(classes(element.className, className))}"${attributesHtml(element.attributesHtml)}>${content}</${element.tag}>`;
}

function labelHtml(label: ActionItemLabel): string {
  const value = label.kind === "text" ? escapeHtml(label.text) : label.html;
  return `<span class="${escapeHtml(classes("action-item__label", label.className))}"${attributesHtml(label.attributesHtml)}><span class="action-item__label-text"${attributesHtml(label.textAttributesHtml)}>${value}</span></span>`;
}

function contentHtml(options: ActionItemContent): string {
  if (options.contentHtml !== undefined) return options.contentHtml;
  if (options.label === undefined) return `${options.leadingHtml ?? ""}${options.trailingHtml ?? ""}`;
  return `${options.leadingHtml ?? ""}${labelHtml(options.label)}${options.trailingHtml ?? ""}`;
}

/** Renders the canonical action-item markup shared by SSR and browser-created UI. */
export function actionItemHtml(options: ActionItemOptions): string {
  const content = contentHtml(options);
  if (options.kind === "single") {
    return elementHtml(options.element, classes("action-item", options.primary === false ? undefined : "action-item__primary"), content);
  }

  const primary = elementHtml(options.primary, "action-item__primary", content);
  const actions = options.engagedActionsHtml ? `<div class="action-item__actions action-item__actions--engaged">${options.engagedActionsHtml}</div>` : "";
  const container = options.container ?? {};
  return `<div class="${escapeHtml(classes(container.className, "action-item"))}"${attributesHtml(container.attributesHtml)}>${primary}${actions}</div>`;
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
