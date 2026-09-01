import { escapeHtml } from "@atelier/shared";
import { attributesHtml, classNames } from "../html.ts";

export interface PanelOptions {
  element: {
    tag: "aside" | "div" | "section";
    className?: string;
    /** Caller-owned attributes. Attribute values containing external input must be escaped. */
    attributesHtml?: string;
  };
  /** Trusted, already-escaped header contents. */
  headerHtml: string;
  /** Trusted, already-escaped body contents. */
  bodyHtml: string;
}

/** Renders a bounded surface with fixed header chrome around a flexible body. */
export function panelHtml(options: PanelOptions): string {
  const { element } = options;
  return `<${element.tag} class="${escapeHtml(classNames("panel", element.className))}"${attributesHtml(element.attributesHtml)}><header class="panel__header">${options.headerHtml}</header><div class="panel__body">${options.bodyHtml}</div></${element.tag}>`;
}
