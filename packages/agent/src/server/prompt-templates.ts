import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { workspaceWorkHostPath } from "@atelier/workspace";

export interface PromptTemplate {
  name: string;
  trigger: string;
  description: string;
  argumentHint?: string;
  prompt: string;
  preserveArguments?: boolean;
}

interface PromptFrontmatter {
  description?: string;
  argumentHint?: string;
}

const promptDirs = [".atelier/prompts", ".pi/prompts"] as const;

const builtinLandPrompt = "Commit and push your work, rebasing when necessary. When successful, delete this workspace.";
const builtinApplicationCommands: PromptTemplate[] = [{
  name: "compact",
  trigger: "/compact",
  description: "Compact the conversation context, optionally with custom instructions.",
  argumentHint: "[instructions]",
  prompt: "/compact",
  preserveArguments: true,
}, {
  name: "name",
  trigger: "/name",
  description: "Rename this workspace, using AI when no name is provided.",
  argumentHint: "[workspace-name]",
  prompt: "/name",
  preserveArguments: true,
}, {
  name: "new",
  trigger: "/new",
  description: "Start a new agent session in this tab.",
  prompt: "/new",
}];

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
  // Application commands are not overridable prompt templates.
  for (const command of builtinApplicationCommands) byName.set(command.name, command);
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
  if (template.preserveArguments) return trimmed;
  return expandBody(template.prompt, splitArgs(match[2] ?? ""));
}

export async function expandPromptTemplate(workspaceId: string, text: string): Promise<string> {
  return expandPromptTemplateText(text, await listPromptTemplates(workspaceId));
}

export function parseCompactCommand(text: string): { customInstructions?: string } | undefined {
  const match = text.trim().match(/^\/compact(?:\s+([\s\S]+))?$/);
  if (!match) return undefined;
  const customInstructions = match[1]?.trim();
  return customInstructions ? { customInstructions } : {};
}

export function parseWorkspaceNameCommand(text: string): { title?: string } | undefined {
  const match = text.trim().match(/^\/name(?:\s+([\s\S]+))?$/);
  if (!match) return undefined;
  const title = match[1]?.trim();
  return title ? { title } : {};
}
