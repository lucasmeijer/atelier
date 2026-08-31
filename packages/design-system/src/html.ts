import { escapeHtml } from "@atelier/shared";

export type HtmlContent =
  | { kind: "text"; text: string }
  /** Trusted, already-escaped HTML. */
  | { kind: "html"; html: string };

export function classNames(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

export function attributesHtml(value?: string): string {
  const attributes = value?.trim();
  return attributes ? ` ${attributes}` : "";
}

export function htmlContent(content: HtmlContent): string {
  return content.kind === "text" ? escapeHtml(content.text) : content.html;
}
