import type { Parser } from "@lezer/common";
import { parser as javascript } from "@lezer/javascript";
import { parser as css } from "@lezer/css";
import { parser as html, configureNesting } from "@lezer/html";
import { parser as json } from "@lezer/json";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";

const parsers = new Map<string, Parser>([
  ["javascript", javascript],
  ["typescript", javascript.configure({ dialect: "ts" })],
  ["jsx", javascript.configure({ dialect: "jsx" })],
  ["tsx", javascript.configure({ dialect: "ts jsx" })],
  ["css", css],
  ["json", json],
  ["html", html.configure({ wrap: configureNesting([
    { tag: "script", parser: javascript },
    { tag: "style", parser: css },
  ]) })],
]);

const roles = tagHighlighter([
  { tag: tags.comment, class: "comment" },
  { tag: tags.keyword, class: "keyword" },
  { tag: tags.number, class: "number" },
  { tag: [tags.bool, tags.null, tags.atom], class: "literal" },
  { tag: [tags.string, tags.regexp], class: "string" },
  { tag: tags.escape, class: "string-expression" },
  { tag: [tags.typeName, tags.className], class: "type" },
  { tag: tags.tagName, class: "tag" },
  { tag: tags.attributeName, class: "attribute" },
  { tag: tags.function(tags.variableName), class: "function" },
  { tag: [tags.variableName, tags.propertyName], class: "variable" },
  { tag: [tags.operator, tags.punctuation], class: "punctuation" },
]);

export interface HighlightSpan { from: number; to: number; role: string }

/** Error-tolerant syntax parsing handles complete files and streamed prefixes alike. */
export function parserHighlightSpans(code: string, language: string): HighlightSpan[] | undefined {
  const parser = parsers.get(language);
  if (!parser) return undefined;
  const spans: HighlightSpan[] = [];
  highlightTree(parser.parse(code), roles, (from, to, role) => { spans.push({ from, to, role }); });
  return spans;
}
