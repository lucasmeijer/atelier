import { renderMarkdown, renderProvisionalMarkdown } from "./markdown.ts";

interface Fence {
  marker: "`" | "~";
  size: number;
}

export interface StreamingMarkdownSnapshot {
  stableHtml: string;
  tailHtml: string;
}

export interface StreamingMarkdownUpdate {
  stableBoundary: number;
  stableHtmlAddition: string;
  tailHtml: string;
}

/**
 * Finds completed top-level blocks that can be rendered independently. This is
 * intentionally more conservative than a Markdown parser: lists, quotes,
 * indented blocks, tables, and potential reference links/definitions remain
 * mutable until the message is finalized. Boundaries index the original source.
 */
export function streamingMarkdownStableBoundary(source: string): number {
  let boundary = 0;
  let fence: Fence | undefined;
  const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
  let offset = 0;

  for (const lineWithEnding of lines) {
    const terminated = /[\r\n]$/.test(lineWithEnding);
    const line = lineWithEnding.replace(/(?:\r\n|\r|\n)$/, "");
    const lineStart = offset;
    offset += lineWithEnding.length;
    fence = nextFence(fence, line);

    // A trailing space may become an indented continuation, not a blank line.
    // Wait on a final CR as well: the next delta may complete a CRLF pair.
    if (!terminated || (lineWithEnding.endsWith("\r") && offset === source.length)) continue;
    if (line.trim() !== "" || fence) continue;
    const candidate = source.slice(boundary, lineStart);
    if (isIndependentCompletedBlock(candidate)) boundary = offset;
  }
  return boundary;
}

function nextFence(open: Fence | undefined, line: string): Fence | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return open;
  const marker = match[1]![0];
  if (marker !== "`" && marker !== "~") throw new Error("fence pattern matched an unsupported marker");
  if (!open) return { marker, size: match[1]!.length };
  const closes = marker === open.marker && match[1]!.length >= open.size && !match[2]!.trim();
  return closes ? undefined : open;
}

function openFence(text: string): Fence | undefined {
  let open: Fence | undefined;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) open = nextFence(open, line);
  return open;
}

function isIndependentCompletedBlock(block: string): boolean {
  if (!block.trim()) return false;
  let fence: Fence | undefined;
  const outsideFenceLines: string[] = [];
  for (const line of block.replace(/\r\n?/g, "\n").split("\n")) {
    const wasInFence = fence !== undefined;
    fence = nextFence(fence, line);
    if (!wasInFence && !fence) outsideFenceLines.push(line);
  }
  if (fence) return false;
  // Reference links (including shortcut links) can depend on definitions anywhere
  // in the document. Keep the first bracket-bearing block and all subsequent
  // blocks together in the mutable tail, preserving one Markdown environment.
  // Deliberately conservative for literal brackets and inline links; fenced code
  // has no reference semantics and can still be committed independently.
  if (outsideFenceLines.some((line) => line.includes("["))) return false;
  if (outsideFenceLines.some((line) => /^(?: {4}|\t| {0,3}(?:[-+*]|\d+[.)])\s| {0,3}>)/.test(line))) return false;
  return !outsideFenceLines.some((line, index) => index > 0 && /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line));
}

/** Make only a temporary parsing copy of an incomplete mutable tail. */
export function repairStreamingMarkdownTail(tail: string): string {
  const fence = openFence(tail);
  if (fence) return `${tail}${tail.endsWith("\n") ? "" : "\n"}${fence.marker.repeat(fence.size)}\n`;

  let repaired = tail;
  const dangling = repaired.match(/(!?)\[([^\]\n]*)\]\(([^)\s]*)$/);
  if (dangling?.[1]) {
    const start = dangling.index!;
    repaired = `${repaired.slice(0, start)}\\!${repaired.slice(start + 1)}`;
  } else if (dangling && /^(?:https?:\/\/|atelier:\/\/)/.test(dangling[3]!)) {
    repaired += ")";
  } else if (/!\[[^\]\n]*$/.test(repaired)) {
    const start = repaired.lastIndexOf("![");
    repaired = `${repaired.slice(0, start)}\\!${repaired.slice(start + 1)}`;
  }

  // An unmatched backtick is already rendered as text. Closing it could turn a
  // large suffix into inline code, so do not apply emphasis repairs either.
  if (hasUnmatchedInlineBacktick(repaired)) return repaired;
  const line = repaired.slice(repaired.lastIndexOf("\n") + 1);
  if (/(?:^|[^\\*])\*\*([^*\n\s][^*\n]*)$/.test(line)) return `${repaired}**`;
  if (/(?:^|[^\\*])\*([^*\n\s][^*\n]*)$/.test(line)) return `${repaired}*`;
  return repaired;
}

function hasUnmatchedInlineBacktick(text: string): boolean {
  let open = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === "`") open = !open;
  }
  return open;
}

export function renderStreamingMarkdownSnapshot(workspaceId: string, source: string): StreamingMarkdownSnapshot {
  const stableBoundary = streamingMarkdownStableBoundary(source);
  return {
    stableHtml: renderMarkdown(workspaceId, source.slice(0, stableBoundary)),
    tailHtml: renderProvisionalMarkdown(workspaceId, repairStreamingMarkdownTail(source.slice(stableBoundary))),
  };
}

/** Bounded state belonging to one append-only live transcript item. */
export class StreamingMarkdownRenderer {
  private stableBoundary = 0;

  constructor(private readonly workspaceId: string) {}

  render(source: string): StreamingMarkdownUpdate {
    const previousBoundary = this.stableBoundary;
    this.stableBoundary = Math.max(previousBoundary, streamingMarkdownStableBoundary(source));
    return {
      stableBoundary: this.stableBoundary,
      stableHtmlAddition: renderMarkdown(this.workspaceId, source.slice(previousBoundary, this.stableBoundary)),
      tailHtml: renderProvisionalMarkdown(this.workspaceId, repairStreamingMarkdownTail(source.slice(this.stableBoundary))),
    };
  }

  sync(source: string): void {
    this.stableBoundary = streamingMarkdownStableBoundary(source);
  }
}
