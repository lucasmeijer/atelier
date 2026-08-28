import path from "node:path";
import { createCssVariablesTheme, createHighlighterCoreSync } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import bash from "@shikijs/langs/bash";
import csharp from "@shikijs/langs/csharp";
import css from "@shikijs/langs/css";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import regex from "@shikijs/langs/regex";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import typescript from "@shikijs/langs/typescript";
import xml from "@shikijs/langs/xml";
import { escapeHtml } from "@atelier/shared";

const theme = createCssVariablesTheme({ name: "atelier-fragment", variablePrefix: "--syntax-", fontStyle: false });
theme.tokenColors?.push(
  { scope: ["constant.numeric"], settings: { foreground: "var(--syntax-number)" } },
  { scope: ["variable", "variable.other", "variable.language"], settings: { foreground: "var(--syntax-variable)" } },
  { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class"], settings: { foreground: "var(--syntax-type)" } },
  { scope: ["constant.language", "constant.other"], settings: { foreground: "var(--syntax-literal)" } },
  { scope: ["entity.other.attribute-name"], settings: { foreground: "var(--syntax-attribute)" } },
  { scope: ["entity.name.tag"], settings: { foreground: "var(--syntax-tag)" } },
);
const highlighter = createHighlighterCoreSync({
  engine: createJavaScriptRegexEngine(),
  themes: [theme],
  langs: [bash, csharp, css, go, html, java, javascript, json, jsonc, markdown, python, regex, ruby, rust, typescript, xml],
});

const extensionLanguages = new Map(Object.entries({
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  html: "html", htm: "html", xml: "xml", svg: "xml", css: "css", cs: "csharp", csx: "csharp",
  json: "json", jsonc: "jsonc", md: "markdown", markdown: "markdown", sh: "bash", bash: "bash", zsh: "bash",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", regex: "regex",
}));
const aliases = new Map(Object.entries({
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  htm: "html", shell: "bash", sh: "bash", zsh: "bash", cs: "csharp", csx: "csharp", md: "markdown",
  py: "python", rb: "ruby", rs: "rust",
}));
const supported = new Set(highlighter.getLoadedLanguages());
const colorRole = /^var\(--syntax-(?:token-)?([\w-]+)/;

export interface HighlightRequest { code: string; path?: string; language?: string }
export interface HighlightedCode { html: string; language?: string }

export function languageFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return extensionLanguages.get(extension);
}

function resolveLanguage(language: string | undefined): string | undefined {
  const raw = language?.trim().toLowerCase();
  if (!raw) return undefined;
  const resolved = aliases.get(raw) ?? raw;
  return supported.has(resolved) ? resolved : undefined;
}

/**
 * Shiki's CSS-variable theme maps TextMate scopes into these stable roles:
 * comments, strings/string expressions, keywords, functions, parameters,
 * constants, links and punctuation. Unclassified tokens inherit foreground.
 */
export function highlightCodeHtml(request: HighlightRequest): HighlightedCode {
  const language = resolveLanguage(request.language ?? languageFromPath(request.path));
  if (!language) return { html: escapeHtml(request.code) };
  const lines = highlighter.codeToTokens(request.code, { lang: language, theme: "atelier-fragment" }).tokens;
  const html = lines.map((tokens) => tokens.map((token) => {
    const escaped = escapeHtml(token.content);
    const role = token.color?.match(colorRole)?.[1];
    return role && role !== "foreground" ? `<span class="syntax-${role}">${escaped}</span>` : escaped;
  }).join("")).join("\n");
  return { html, language };
}

export function highlightCodeHtmlForPath(code: string, filePath?: string): HighlightedCode {
  return highlightCodeHtml({ code, path: filePath });
}
