import { escapeHtml } from "@atelier/shared";
import { buttonHtml } from "../button/button-html.ts";
import { Icons } from "../icons/icons-html.ts";
import { attributesHtml } from "../html.ts";
import { panelHtml } from "../panel/panel-html.ts";

export interface DialogOptions {
  element: {
    id?: string;
    /** Caller-owned attributes; aria-label is owned by titleCaption. Attribute values containing external input must be escaped. */
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
  const closeLabel = options.closeLabel ?? "Close dialog";
  const cancelButton = options.omitCancelButton ? "" : `<form class="dialog__close-form" method="dialog">${buttonHtml({
    type: "submit",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml: Icons.Close, label: closeLabel },
  })}</form>`;
  const panel = panelHtml({
    element: { tag: "div" },
    headerHtml: `<h2 class="panel__title dialog__title">${options.iconHtml}<span>${escapeHtml(options.titleCaption)}</span></h2>${cancelButton}`,
    bodyHtml: options.bodyHtml,
    bodyLayout: options.bodyLayout ?? "padded",
    bodyOverflow: "scroll",
    footerHtml: options.footerHtml,
  });
  return `<dialog${id} class="${escapeHtml("dialog")}" aria-label="${escapeHtml(options.titleCaption)}"${attributesHtml(element.attributesHtml)}>${panel}</dialog>`;
}
