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
  /** Trusted, already-escaped decorative icon. */
  iconHtml: string;
  /** Plain-text title caption. */
  titleCaption: string;
  /** Trusted, already-escaped body contents. */
  bodyHtml: string;
  /** Padded by default. Use full-bleed when child regions own spacing or separators must reach both edges. */
  bodyLayout?: "padded" | "full-bleed";
  /** Trusted, already-escaped footer contents. Omit when the dialog has no footer actions. */
  footerHtml?: string;
  /** Accessible close-button label. */
  closeLabel?: string;
  /** Omits the header's cancel control when the flow must provide its own completion action. */
  omitCancelButton?: boolean;
}

/** Renders a native modal host around the design-system panel surface. */
export function dialogHtml(options: DialogOptions): string {
  const { element } = options;
  const id = element.id === undefined ? "" : ` id="${escapeHtml(element.id)}"`;
  const closeLabel = escapeHtml(options.closeLabel ?? "Close dialog");
  const cancelButton = options.omitCancelButton ? "" : `<form class="dialog__close-form" method="dialog"><button class="dialog__close button secondary icon-only" value="close" title="${closeLabel}" aria-label="${closeLabel}">${Icons.Close}</button></form>`;
  const panel = panelHtml({
    element: { tag: "div", className: "dialog__panel" },
    headerHtml: `<h2 class="panel__title dialog__title">${options.iconHtml}<span>${escapeHtml(options.titleCaption)}</span></h2>${cancelButton}`,
    bodyHtml: options.bodyHtml,
    bodyClassName: classNames("dialog__body", options.bodyLayout === "full-bleed" && "dialog__body--full-bleed"),
    footerHtml: options.footerHtml,
  });
  return `<dialog${id} class="${escapeHtml(classNames("dialog", "dialog--panel", element.className))}"${attributesHtml(element.attributesHtml)}>${panel}</dialog>`;
}
