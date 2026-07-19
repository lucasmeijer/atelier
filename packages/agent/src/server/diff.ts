export interface DiffOperation {
  oldText: string;
  newText: string;
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.replaceAll("\r\n", "\n").split("\n");
}

export interface DiffDisplayLine {
  kind: "context" | "removed" | "added";
  text: string;
}

export function parseUnifiedPatchHunks(patch: string): DiffDisplayLine[][] {
  const hunks: DiffDisplayLine[][] = [];
  let hunk: DiffDisplayLine[] | undefined;
  for (const line of patch.replaceAll("\r\n", "\n").split("\n")) {
    if (line.startsWith("@@")) {
      if (hunk) hunks.push(hunk);
      hunk = [];
    } else if (!hunk || line.startsWith("\\ No newline")) {
      continue;
    } else if (line.startsWith(" ")) {
      hunk.push({ kind: "context", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      hunk.push({ kind: "removed", text: line.slice(1) });
    } else if (line.startsWith("+")) {
      hunk.push({ kind: "added", text: line.slice(1) });
    }
  }
  if (hunk) hunks.push(hunk);
  return hunks;
}

export function contextualDiffLines(operation: DiffOperation, contextLines = 3): DiffDisplayLine[] {
  const oldLines = splitLines(operation.oldText);
  const newLines = splitLines(operation.newText);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) suffix++;

  const before = oldLines.slice(Math.max(0, prefix - contextLines), prefix);
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const after = oldLines.slice(oldLines.length - suffix, Math.min(oldLines.length, oldLines.length - suffix + contextLines));
  return [
    ...before.map((text) => ({ kind: "context" as const, text })),
    ...removed.map((text) => ({ kind: "removed" as const, text })),
    ...added.map((text) => ({ kind: "added" as const, text })),
    ...after.map((text) => ({ kind: "context" as const, text })),
  ];
}

function operationStats(operation: DiffOperation): { added: number; deleted: number } {
  const oldLines = splitLines(operation.oldText);
  const newLines = splitLines(operation.newText);
  if (oldLines.length * newLines.length > 40_000) return { added: newLines.length, deleted: oldLines.length };

  const lcs = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      lcs[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? lcs[oldIndex + 1][newIndex + 1] + 1
        : Math.max(lcs[oldIndex + 1][newIndex], lcs[oldIndex][newIndex + 1]);
    }
  }
  const unchanged = lcs[0][0];
  return { added: newLines.length - unchanged, deleted: oldLines.length - unchanged };
}

export function diffStats(operations: DiffOperation[]): { added: number; deleted: number } {
  return operations.reduce((total, operation) => {
    const stats = operationStats(operation);
    total.added += stats.added;
    total.deleted += stats.deleted;
    return total;
  }, { added: 0, deleted: 0 });
}
