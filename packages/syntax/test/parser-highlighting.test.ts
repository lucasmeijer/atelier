import { expect, test } from "bun:test";
import { parserHighlightSpans } from "../src/parser-highlighting.ts";
import { HighlightCache } from "../src/highlight-cache.ts";
import { highlightCodeHtml } from "../src/highlight.ts";
import { fixtures, prefixes, source } from "../bench/cases.ts";
import { languageFromPath } from "../src/index.ts";

test("parser token ranges remain ordered and inside incomplete captured inputs", () => {
  for (const fixture of fixtures) {
    for (const code of prefixes(source(fixture), 256)) {
      const spans = parserHighlightSpans(code, languageFromPath(fixture)!)!;
      expect(spans).toBeDefined();
      let end = 0;
      for (const span of spans) {
        expect(span.from).toBeGreaterThanOrEqual(end);
        expect(span.to).toBeGreaterThan(span.from);
        expect(span.to).toBeLessThanOrEqual(code.length);
        end = span.to;
      }
    }
  }
});

test("parser recognizes nested web languages and TypeScript JSX", () => {
  const code = '<style>.x { color: red }</style><script>const count = 42;</script>';
  const tokens = parserHighlightSpans(code, "html")!.map((span) => [code.slice(span.from, span.to), span.role]);
  expect(tokens).toContainEqual(["const", "keyword"]);
  expect(tokens).toContainEqual(["42", "number"]);
  expect(tokens).toContainEqual(["style", "tag"]);
  expect(parserHighlightSpans("const el: Element = <main />;", "tsx")!.length).toBeGreaterThan(0);
  expect(parserHighlightSpans("print('hello')", "python")).toBeUndefined();
});

test("highlight cache shares resolved aliases without sharing different languages", () => {
  const code = "const cacheIdentityTest = 92841;";
  const first = highlightCodeHtml({ code, language: "js" });
  expect(Object.isFrozen(first)).toBe(true);
  expect(highlightCodeHtml({ code, path: "same.js" })).toBe(first);
  expect(highlightCodeHtml({ code: `${code}\n`, language: "js" })).not.toBe(first);
  expect(highlightCodeHtml({ code, language: "css" })).not.toBe(first);
});

test("cache evicts least recently used entries at the entry limit", () => {
  const cache = new HighlightCache(100, 2);
  const result = { html: "1234" };
  cache.set("a", result);
  cache.set("b", result);
  expect(cache.get("a")).toBe(result);
  cache.set("c", result);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe(result);
  expect(cache.get("c")).toBe(result);
});

test("cache accounts for replacements and oversized entries within its character limit", () => {
  const cache = new HighlightCache(12, 10);
  cache.set("a", { html: "1234" });
  cache.set("c", { html: "1234" });
  cache.set("c", { html: "12345678" });
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("c")?.html).toBe("12345678");
  cache.set("oversized", { html: "1234" });
  expect(cache.get("oversized")).toBeUndefined();
  expect(cache.get("c")).toBeDefined();
  cache.set("c", { html: "123456789012" });
  expect(cache.get("c")).toBeUndefined();
});
