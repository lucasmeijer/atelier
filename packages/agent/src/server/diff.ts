export interface DiffOperation {
  oldText: string;
  newText: string;
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.replaceAll("\r\n", "\n").split("\n");
}

interface DiffStats {
  added: number;
  deleted: number;
}

function operationStats(operation: DiffOperation): DiffStats {
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

export function diffStats(operations: DiffOperation[]): DiffStats {
  return operations.reduce((total, operation) => {
    const stats = operationStats(operation);
    total.added += stats.added;
    total.deleted += stats.deleted;
    return total;
  }, { added: 0, deleted: 0 });
}
