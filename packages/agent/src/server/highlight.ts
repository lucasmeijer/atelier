import path from "node:path";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import { escapeHtml } from "./html.ts";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);

const extensionLanguages: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  css: "css",
  cs: "csharp",
  csx: "csharp",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
};

const languageAliases: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  html: "html",
  htm: "html",
  shell: "bash",
  zsh: "bash",
  cs: "csharp",
  csx: "csharp",
  csharp: "csharp",
  jsonc: "json",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
};

export function languageFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const extension = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return extensionLanguages[extension];
}

function normalizeLanguage(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const normalized = lang.trim().toLowerCase();
  if (!normalized) return undefined;
  const language = languageAliases[normalized] ?? normalized;
  return hljs.getLanguage(language) ? language : undefined;
}

export function highlightCodeHtml(code: string, lang?: string): { html: string; language?: string } {
  const language = normalizeLanguage(lang);
  if (!language) return { html: escapeHtml(code) };
  try {
    return { html: hljs.highlight(code, { language, ignoreIllegals: true }).value, language };
  } catch {
    return { html: escapeHtml(code) };
  }
}

export function highlightCodeHtmlForPath(code: string, filePath?: string): { html: string; language?: string } {
  return highlightCodeHtml(code, languageFromPath(filePath));
}
