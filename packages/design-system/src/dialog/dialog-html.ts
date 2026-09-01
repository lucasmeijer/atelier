import { escapeHtml } from "@atelier/shared";
import { Icons } from "../icons/icons-html.ts";
import { attributesHtml, classNames } from "../html.ts";
import { panelHtml } from "../panel/panel-html.ts";

export interface DialogOptions {
  element: {
    id?: string;
    className?: string;
    /** Caller-owned attributes. Attribute values containing external input must be escaped. */
    attributesHtml?: string;
  };
  /** Trusted, already-escaped title contents. */
  titleHtml: string;
  /** Trusted, already-escaped body contents. */
  bodyHtml: string;
  /** Trusted, already-escaped footer contents. Omit when the dialog has no footer actions. */
  footerHtml?: string;
  /** Accessible close-button label. */
  closeLabel?: string;
}

/** Renders a native modal host around the design-system panel surface. */
export function dialogHtml(options: DialogOptions): string {
  const { element } = options;
  const id = element.id === undefined ? "" : ` id="${escapeHtml(element.id)}"`;
  const closeLabel = escapeHtml(options.closeLabel ?? "Close dialog");
  const panel = panelHtml({
    element: { tag: "div", className: "dialog__panel" },
    headerHtml: `<h2 class="title dialog__title">${options.titleHtml}</h2><form class="dialog__close-form" method="dialog"><button class="dialog__close button secondary icon-only" value="close" title="${closeLabel}" aria-label="${closeLabel}">${Icons.Close}</button></form>`,
    bodyHtml: options.bodyHtml,
    footerHtml: options.footerHtml,
  });
  return `<dialog${id} class="${escapeHtml(classNames("dialog", "dialog--panel", element.className))}"${attributesHtml(element.attributesHtml)}>${panel}</dialog>`;
}
