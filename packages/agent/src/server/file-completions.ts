import { posix } from "node:path";
import { actionItemHtml } from "@atelier/design-system/action-item";
import { execWorkspaceCommand, workspaceRoot } from "@atelier/workspace";
import { escapeHtml } from "./html.ts";

export type FileCompletionMode = "direct" | "fuzzy";

export interface FileCompletion {
  path: string;
  directory: boolean;
}

interface SearchSpec {
  baseDir: string;
  query: string;
  displayBase: string;
}

function normalizeDisplayPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function resolveSearchBase(displayBase: string): string {
  if (displayBase.startsWith("/") || displayBase.startsWith("~/") || displayBase === "~") return displayBase;
  return posix.join(workspaceRoot, displayBase);
}

export function fileCompletionSearchSpec(rawQuery: string, mode: FileCompletionMode): SearchSpec {
  let query = normalizeDisplayPath(rawQuery);
  if (mode === "direct" && query === ".") query = "";
  const slash = query.lastIndexOf("/");
  if (slash === -1) return { baseDir: workspaceRoot, query, displayBase: "" };
  const displayBase = query.slice(0, slash + 1);
  return { baseDir: resolveSearchBase(displayBase), query: query.slice(slash + 1), displayBase };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function displayPath(spec: SearchSpec, found: string): string {
  const normalized = normalizeDisplayPath(found).replace(/^\.\//, "").replace(/\/$/, "");
  if (!spec.displayBase) return normalized;
  if (spec.displayBase === "/") return `/${normalized}`;
  return `${spec.displayBase}${normalized}`;
}

function completionScore(path: string, query: string, directory: boolean): number {
  if (!query) return directory ? 2 : 1;
  const name = posix.basename(path).toLowerCase();
  const normalizedQuery = query.toLowerCase();
  let score = 0;
  if (name === normalizedQuery) score = 100;
  else if (name.startsWith(normalizedQuery)) score = 80;
  else if (name.includes(normalizedQuery)) score = 50;
  else if (path.toLowerCase().includes(normalizedQuery)) score = 30;
  return score + (directory && score > 0 ? 10 : 0);
}

export async function listFileCompletions(workspaceId: string, rawQuery: string, mode: FileCompletionMode): Promise<FileCompletion[]> {
  const spec = fileCompletionSearchSpec(rawQuery, mode);
  const pattern = spec.query ? (mode === "direct" ? `^${escapeRegex(spec.query)}` : spec.query) : undefined;
  const script = `base="$1"
case "$base" in
  "~") base="$HOME" ;;
  "~/"*) base="$HOME/\${base#\~/}" ;;
esac
shift
exec fd "$@" --base-directory "$base" --max-results 100 --ignore-case --type f --type d --follow --hidden --exclude .git --exclude '.git/*' --exclude '.git/**' --print0`;
  const searchArgs = [...(mode === "direct" ? ["--max-depth", "1"] : []), ...(pattern ? [pattern] : [])];
  const args = ["sh", "-c", script, "file-completions", spec.baseDir, ...searchArgs];
  const result = await execWorkspaceCommand(workspaceId, args, { workdir: workspaceRoot });
  if (result.exitCode !== 0) return [];

  const completions = result.stdout.split("\0").filter(Boolean).map((entry) => {
    const directory = entry.endsWith("/");
    const path = displayPath(spec, entry);
    return { path, directory, score: completionScore(path, spec.query, directory) };
  }).filter((entry) => mode === "direct" || entry.score > 0);

  completions.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return completions.slice(0, 20).map(({ score: _score, ...completion }) => completion);
}

export function renderFileCompletionMenu(completions: readonly FileCompletion[]): string {
  if (completions.length === 0) return `<div class="popup-menu autocomplete-menu autocomplete-empty">No matching files</div>`;
  return `<div class="popup-menu autocomplete-menu action-list" role="listbox" aria-label="Files and directories">${completions.map((completion, index) => {
    const path = completion.directory ? `${completion.path}/` : completion.path;
    return actionItemHtml({
      kind: "single",
      label: { kind: "text", text: path, className: "agent-file-path" },
      element: {
        tag: "button",
        className: `agent-completion-option${index === 0 ? " active" : ""}`,
        attributesHtml: `type="button" role="option" aria-selected="${index === 0 ? "true" : "false"}" data-completion-kind="file" data-file-path="${escapeHtml(path)}" data-file-directory="${completion.directory}"`,
      },
    });
  }).join("")}</div>`;
}
