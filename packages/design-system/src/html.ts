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
  if (!attributes) return "";
  // Parse attribute boundaries, skipping quoted values (which may mention CSS).
  // Integration is intentionally extensible; component paint is not.
  const attribute = /([^\s=<>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
  for (const match of attributes.matchAll(attribute)) {
    if (["class", "style"].includes(match[1]!.toLowerCase())) {
      throw new Error(`Design-system integration attributes cannot include ${match[1]}`);
    }
  }
  return ` ${attributes}`;
}

export function htmlContent(content: HtmlContent): string {
  return content.kind === "text" ? escapeHtml(content.text) : content.html;
}
