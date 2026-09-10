export interface WorkspaceFileTarget {
  path: string;
  line?: number;
  column?: number;
}

function positiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parse a link target; path resolution belongs to the workspace open operation. */
export function parseWorkspaceFileTarget(params: URLSearchParams): WorkspaceFileTarget {
  return {
    path: params.get("path") ?? "",
    line: positiveInteger(params.get("line")),
    column: positiveInteger(params.get("column")),
  };
}

export function workspaceFileOpenUrl(workspaceId: string, path: string, position: Omit<WorkspaceFileTarget, "path"> = {}, filesViewId?: string): string {
  const query = new URLSearchParams({ path });
  if (position.line) query.set("line", String(position.line));
  if (position.column) query.set("column", String(position.column));
  if (filesViewId) query.set("filesView", filesViewId);
  const endpoint = filesViewId ? "files-view/open" : "file/open";
  return `/workspaces/${encodeURIComponent(workspaceId)}/${endpoint}?${query}`;
}
