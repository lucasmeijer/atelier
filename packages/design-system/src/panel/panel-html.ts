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
  /** Trusted, already-escaped footer contents. Omit when the surface has no footer actions. */
  footerHtml?: string;
}

/** Renders a bounded surface with fixed chrome around a flexible body. */
export function panelHtml(options: PanelOptions): string {
  const { element } = options;
  const footer = options.footerHtml === undefined ? "" : `<footer class="panel__footer">${options.footerHtml}</footer>`;
  return `<${element.tag} class="${escapeHtml(classNames("panel", element.className))}"${attributesHtml(element.attributesHtml)}><header class="panel__header">${options.headerHtml}</header><div class="panel__body">${options.bodyHtml}</div>${footer}</${element.tag}>`;
}
