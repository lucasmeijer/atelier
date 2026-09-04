import path from "node:path";
import { createCssVariablesTheme, createHighlighterCoreSync } from "@shikijs/core";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import astro from "@shikijs/langs/astro";
import bash from "@shikijs/langs/bash";
import csharp from "@shikijs/langs/csharp";
import css from "@shikijs/langs/css";
import docker from "@shikijs/langs/docker";
import erb from "@shikijs/langs/erb";
import go from "@shikijs/langs/go";
import glsl from "@shikijs/langs/glsl";
import hcl from "@shikijs/langs/hcl";
import hlsl from "@shikijs/langs/hlsl";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import jsx from "@shikijs/langs/jsx";
import markdown from "@shikijs/langs/markdown";
import php from "@shikijs/langs/php";
import python from "@shikijs/langs/python";
import regex from "@shikijs/langs/regex";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import scss from "@shikijs/langs/scss";
import sql from "@shikijs/langs/sql";
import svelte from "@shikijs/langs/svelte";
import terraform from "@shikijs/langs/terraform";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import vue from "@shikijs/langs/vue";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import { escapeHtml } from "@atelier/shared";
import { shaderLanguageFromExtension } from "./shader-languages.ts";
import { parserHighlightSpans } from "./parser-highlighting.ts";
import { HighlightCache } from "./highlight-cache.ts";

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
  engine: await createOnigurumaEngine(import("@shikijs/engine-oniguruma/wasm-inlined")),
  themes: [theme],
  langs: [astro, bash, csharp, css, docker, erb, go, glsl, hcl, hlsl, html, java, javascript, json, jsonc, jsx, markdown, php, python, regex, ruby, rust, scss, sql, svelte, terraform, tsx, typescript, vue, xml, yaml],
});

const extensionLanguages = new Map(Object.entries({
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  html: "html", htm: "html", erb: "erb", rhtml: "erb", xml: "xml", svg: "xml", css: "css", scss: "scss", cs: "csharp", csx: "csharp",
  json: "json", jsonc: "jsonc", yaml: "yaml", yml: "yaml", md: "markdown", markdown: "markdown", sh: "bash", bash: "bash", zsh: "bash",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", regex: "regex", sql: "sql", dockerfile: "docker",
  vue: "vue", svelte: "svelte", astro: "astro", tf: "terraform", tfvars: "terraform", hcl: "hcl", php: "php", phtml: "php",
}));
const aliases = new Map(Object.entries({
  ts: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript", htm: "html", yml: "yaml",
  dockerfile: "docker", shell: "bash", sh: "bash", zsh: "bash", cs: "csharp", csx: "csharp", md: "markdown",
  py: "python", rb: "ruby", rs: "rust", tf: "terraform",
}));
const supported = new Set(highlighter.getLoadedLanguages());
const colorRole = /^var\(--syntax-(?:token-)?([\w-]+)/;
// The theme is immutable for this module's lifetime; language + source identify its output.
const cache = new HighlightCache(2_000_000, 256);

export interface HighlightRequest { code: string; path?: string; language?: string }
export interface HighlightedCode { readonly html: string; readonly language?: string }

export function languageFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const basename = path.basename(filePath).toLowerCase();
  if (basename === "dockerfile") return "docker";
  const extension = path.extname(basename).slice(1);
  return extensionLanguages.get(extension) ?? shaderLanguageFromExtension(extension);
}

function resolveLanguage(language: string | undefined): string | undefined {
  const raw = language?.trim().toLowerCase();
  if (!raw) return undefined;
  const resolved = aliases.get(raw) ?? raw;
  return supported.has(resolved) ? resolved : undefined;
}

/**
 * Map parser tokens or TextMate scopes to stable syntax roles. Identical source
 * and resolved language share immutable output; colors are supplied by CSS.
 */
export function highlightCodeHtml(request: HighlightRequest): HighlightedCode {
  const language = resolveLanguage(request.language ?? languageFromPath(request.path));
  const key = `${language ?? ""}\0${request.code}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const result = Object.freeze(highlightUncached(request.code, language));
  cache.set(key, result);
  return result;
}

function highlightUncached(code: string, language: string | undefined): HighlightedCode {
  if (!language) return { html: escapeHtml(code) };
  const spans = parserHighlightSpans(code, language);
  if (spans) {
    const fragments: string[] = [];
    let end = 0;
    for (const span of spans) {
      fragments.push(escapeHtml(code.slice(end, span.from)));
      fragments.push(`<span class="syntax-${span.role}">${escapeHtml(code.slice(span.from, span.to))}</span>`);
      end = span.to;
    }
    fragments.push(escapeHtml(code.slice(end)));
    return { html: fragments.join(""), language };
  }
  const lines = highlighter.codeToTokens(code, { lang: language, theme: "atelier-fragment" }).tokens;
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
