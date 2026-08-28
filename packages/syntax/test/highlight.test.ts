import { describe, expect, test } from "bun:test";
import palettes from "./fixtures/palettes.json";
import { highlightCodeHtml, languageFromPath } from "../src/index.ts";

describe("Atelier syntax highlighting", () => {
  test("resolves paths and emits theme roles", () => {
    expect(languageFromPath("src/view.tsx")).toBe("typescript");
    const result = highlightCodeHtml({ code: "const answer: number = 42; // meaning", path: "view.ts" });
    expect(result.language).toBe("typescript");
    expect(result.html).toContain("syntax-keyword");
    expect(highlightCodeHtml({ code: "// meaning", language: "typescript" }).html).toContain("syntax-comment");
  });
  test("safely escapes unsupported and incomplete input", () => {
    expect(highlightCodeHtml({ code: '<script>&', language: "unknown" })).toEqual({ html: "&lt;script&gt;&amp;" });
    expect(() => highlightCodeHtml({ code: 'const value = "', language: "ts" })).not.toThrow();
  });

  test("keeps the five captured palettes distinct", () => {
    expect(Object.keys(palettes)).toEqual(["daylight", "cappuccino", "tokyo-night", "midnight", "nord"]);
    expect(new Set(Object.values(palettes).map((palette) => palette.keyword)).size).toBe(5);
    expect(new Set(Object.values(palettes).map((palette) => palette.string)).size).toBe(5);
  });
});
