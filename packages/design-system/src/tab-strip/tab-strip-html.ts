import { escapeHtml } from "@atelier/shared";
import { actionItemHtml, type ActionItemLabel, type ActionItemElement } from "../action-item/action-item-html.ts";
import { attributesHtml } from "../html.ts";

/** Closable tabs share Work pane anatomy; feature forms and selection stay feature-owned. */
export function tabHtml(options: {
  label: ActionItemLabel; iconHtml?: string; metadataHtml?: string;
  selected: boolean; primary: ActionItemElement; containerAttributesHtml?: string; closeHtml?: string;
}): string {
  return actionItemHtml({
    kind: "compound", label: options.label, leadingHtml: options.iconHtml, trailingHtml: options.metadataHtml,
    container: { attributesHtml: options.containerAttributesHtml },
    primary: { tag: options.primary.tag, attributesHtml: `role="tab" aria-selected="${options.selected}" tabindex="${options.selected ? 0 : -1}" ${options.primary.attributesHtml ?? ""}` },
    engagedActionsHtml: options.closeHtml,
  });
}
export function tabStripHtml(options: { label: string; tabsHtml: string; attributesHtml?: string }): string {
  return `<div class="tab-strip" role="tablist" aria-label="${escapeHtml(options.label)}"${attributesHtml(options.attributesHtml)}>${options.tabsHtml}</div>`;
}
