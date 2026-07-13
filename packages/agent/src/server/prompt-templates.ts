import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { workspaceWorkHostPath } from "@atelier/workspace";
import { escapeHtml } from "./html.ts";

export interface PromptTemplate {
  name: string;
  trigger: string;
  description: string;
  argumentHint?: string;
  prompt: string;
}

interface PromptFrontmatter {
  description?: string;
  argumentHint?: string;
}

const promptDirs = [".atelier/prompts", ".pi/prompts"] as const;

const builtinLandPrompt = "Commit and push your work, rebasing when necessary. When successful, delete this workspace.";

function parseFrontmatter(markdown: string): { frontmatter: PromptFrontmatter; body: string } {
  if (!markdown.startsWith("---\n")) return { frontmatter: {}, body: markdown };
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: markdown };
  const raw = markdown.slice(4, end).trim();
  const body = markdown.slice(end + "\n---".length).replace(/^\r?\n/, "");
  const frontmatter: PromptFrontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key === "description") frontmatter.description = value;
    if (key === "argument-hint") frontmatter.argumentHint = value;
  }
  return { frontmatter, body };
}

function fallbackDescription(body: string): string {
  return body.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Prompt template";
}

function splitArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;
  for (const char of text.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function expandBody(body: string, args: string[]): string {
  const all = args.join(" ");
  return body
    .replace(/\$ARGUMENTS\b/g, all)
    .replace(/\$@/g, all)
    .replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_match, startRaw: string, lengthRaw: string | undefined) => {
      const start = Number(startRaw) - 1;
      const length = lengthRaw === undefined ? undefined : Number(lengthRaw);
      return args.slice(start, length === undefined ? undefined : start + length).join(" ");
    })
    .replace(/\$\{(\d+):-([^}]*)\}/g, (_match, indexRaw: string, fallback: string) => args[Number(indexRaw) - 1] || fallback)
    .replace(/\$(\d+)\b/g, (_match, indexRaw: string) => args[Number(indexRaw) - 1] ?? "");
}

export async function loadPromptTemplatesFromRoot(root: string): Promise<PromptTemplate[]> {
  const byName = new Map<string, PromptTemplate>();
  for (const dir of promptDirs) {
    const path = join(root, dir);
    const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const name = basename(entry.name, ".md");
      if (!name || byName.has(name)) continue;
      const markdown = await Bun.file(join(path, entry.name)).text();
      const { frontmatter, body } = parseFrontmatter(markdown);
      byName.set(name, {
        name,
        trigger: `/${name}`,
        description: frontmatter.description || fallbackDescription(body),
        argumentHint: frontmatter.argumentHint,
        prompt: body,
      });
    }
  }
  if (!byName.has("land")) {
    byName.set("land", { name: "land", trigger: "/land", description: builtinLandPrompt, prompt: builtinLandPrompt });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listPromptTemplates(workspaceId: string): Promise<PromptTemplate[]> {
  return await loadPromptTemplatesFromRoot(workspaceWorkHostPath(workspaceId));
}

export function expandPromptTemplateText(text: string, templates: readonly PromptTemplate[]): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^(\/[^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return text;
  const template = templates.find((candidate) => candidate.trigger === match[1]);
  if (!template) return text;
  return expandBody(template.prompt, splitArgs(match[2] ?? ""));
}

export async function expandPromptTemplate(workspaceId: string, text: string): Promise<string> {
  return expandPromptTemplateText(text, await listPromptTemplates(workspaceId));
}

export function renderPromptTemplateMenu(templates: readonly PromptTemplate[], query: string): string {
  const normalized = query.toLowerCase();
  const filtered = templates.filter((template) => !normalized || template.name.toLowerCase().includes(normalized)).slice(0, 12);
  if (filtered.length === 0) return `<div class="agent-completion-menu empty">No prompt templates</div>`;
  return `<div class="agent-completion-menu" role="listbox" aria-label="Prompt templates">${filtered.map((template, index) => {
    const preview = `<pre class="agent-template-preview">${escapeHtml(template.prompt)}</pre>`;
    return `<button type="button" class="agent-completion-option agent-template-option${index === 0 ? " active" : ""}" role="option" aria-selected="${index === 0 ? "true" : "false"}" data-completion-kind="prompt-template" data-template-trigger="${escapeHtml(template.trigger)}" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="template" data-atelier-fullscreen-title-value="${escapeHtml(template.trigger)}">
      <span class="agent-template-name">${escapeHtml(template.trigger)}</span>${template.argumentHint ? `<span class="agent-template-args">${escapeHtml(template.argumentHint)}</span>` : ""}<span class="agent-template-desc">${escapeHtml(template.description)}</span>
      <template data-atelier-fullscreen-target="content">${preview}</template>
    </button>`;
  }).join("")}</div>`;
}
