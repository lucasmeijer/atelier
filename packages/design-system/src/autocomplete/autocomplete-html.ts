import { escapeHtml } from "@atelier/shared";
import { attributesHtml, classNames, htmlContent, type HtmlContent } from "../html.ts";

interface AutocompleteResultsOptions {
  kind: "results";
  label: string;
  /** Trusted, already-escaped option markup. */
  contentHtml: string;
  className?: string;
  /** Caller-owned attributes. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
}

interface AutocompleteMessageOptions {
  kind: "message";
  content: HtmlContent;
  role?: "status";
  className?: string;
  /** Caller-owned attributes. Attribute values containing external input must be escaped. */
  attributesHtml?: string;
}

export type AutocompleteOptions = AutocompleteResultsOptions | AutocompleteMessageOptions;

/** Renders a full-width result list or status message for an autocomplete interaction. */
export function autocompleteHtml(options: AutocompleteOptions): string {
  const results = options.kind === "results";
  const className = classNames("floating-surface", "autocomplete", results ? "action-list" : "autocomplete-empty", options.className);
  const semantics = results
    ? ` role="listbox" aria-label="${escapeHtml(options.label)}"`
    : options.role ? ` role="${options.role}"` : "";
  const content = results ? options.contentHtml : htmlContent(options.content);
  return `<div class="${escapeHtml(className)}"${semantics}${attributesHtml(options.attributesHtml)}>${content}</div>`;
}
