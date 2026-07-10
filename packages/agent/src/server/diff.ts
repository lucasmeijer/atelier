import { escapeHtml } from "./html.ts";

export interface DiffOperation {
  oldText: string;
  newText: string;
}

type DiffLine = { kind: "ctx" | "del" | "add"; text: string };

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replaceAll("\r\n", "\n").split("\n");
}

function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const rows = oldLines.length;
  const cols = newLines.length;
  if (rows * cols > 40_000) {
    return [
      ...oldLines.map((text) => ({ kind: "del" as const, text })),
      ...newLines.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  const lcs = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && oldLines[i] === newLines[j]) {
      out.push({ kind: "ctx", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (j < cols && (i >= rows || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push({ kind: "add", text: newLines[j] });
      j += 1;
    } else if (i < rows) {
      out.push({ kind: "del", text: oldLines[i] });
      i += 1;
    }
  }
  return out;
}

function diffOperationLines(operations: DiffOperation[]): DiffLine[] {
  return operations.flatMap((operation, index) => {
    const diff = diffLines(operation.oldText, operation.newText);
    if (operations.length <= 1 || index === 0) return diff;
    return [{ kind: "ctx" as const, text: "" }, ...diff];
  });
}

export function diffStats(operations: DiffOperation[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of diffOperationLines(operations)) {
    if (line.kind === "add") added += 1;
    if (line.kind === "del") deleted += 1;
  }
  return { added, deleted };
}

export function renderDiffHtml(operations: DiffOperation[]): string {
  if (operations.length === 0) return "";
  const lines = diffOperationLines(operations);
  if (lines.length === 0) return "";
  return `<div class="agent-diff">${lines.map((line) => {
    const mark = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
    return `<div class="agent-diff-line ${line.kind}"><span class="agent-diff-mark">${mark}</span><code>${escapeHtml(line.text)}</code></div>`;
  }).join("")}</div>`;
}
