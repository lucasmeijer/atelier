/**
 * Neutral transcript model for the pi-backed runtime.
 *
 * Records are a flattened, renderer-friendly view of a session's active path.
 * `buildSections()` groups them into sections: one user message plus everything
 * the agent did until its final assistant message (the one without tool calls).
 */

export interface ImageRef {
  mimeType: string;
  data: string; // base64
}

type AssistantPart =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "toolCall"; callId: string; name: string; args: unknown };

export type TranscriptRecord =
  | { kind: "user"; id: string; text: string; images: ImageRef[]; timestamp: number; rewindable?: boolean }
  | { kind: "assistant"; id: string; parts: AssistantPart[]; stopReason: string; errorMessage?: string; outTokens: number; cost: number; timestamp: number }
  | { kind: "toolResult"; callId: string; text: string; isError: boolean; timestamp: number; details?: unknown }
  | { kind: "note"; id?: string; text: string; tone: NoteTone; timestamp?: number };

type NoteTone = "system" | "summary" | "error";

export interface ToolView {
  callId: string;
  name: string;
  args: unknown;
  status: "streaming" | "running" | "ok" | "error";
  resultText?: string;
  /** Raw argument JSON accumulated while the tool call streams in. */
  argsStream?: string;
  /** Set while a bash command runs inside a tmux session (live terminal attach). */
  tmuxSession?: string;
  /** Only attach the live terminal once the tool has been running for a bit. */
  terminalVisible?: boolean;
  /** Wall-clock start of execution (for the elapsed display). */
  startedAt?: number;
  /** Timeout in seconds, when the tool has one (bash). */
  timeoutSeconds?: number;
  /** Structured tool details persisted for UI rendering (not sent as text to the model). */
  details?: unknown;
}

export type SectionItem =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string; stopReason?: string }
  | { type: "tool"; tool: ToolView }
  | { type: "note"; text: string; tone: NoteTone };

interface SectionStats {
  tools: number;
  durationMs: number;
  outTokens: number;
  cost: number;
}

export interface SectionView {
  sid: string;
  /** Wall-clock start of a live (streaming) section, for the elapsed/stop button. */
  startedAt?: number;
  /** Entry id of the user message: anchor for rewind. */
  userEntryId?: string;
  user?: { text: string; images: ImageRef[] };
  items: SectionItem[];
  finalText?: string;
  errorMessage?: string;
  stats: SectionStats;
  streaming: boolean;
  /** Standalone, always-visible note (rewind/branch summaries). */
  summaryNote?: string;
}

export function buildSections(records: TranscriptRecord[]): SectionView[] {
  const sections: SectionView[] = [];
  let current: SectionView | undefined;
  let userTimestamp = 0;
  let lastTimestamp = 0;
  const toolItems = new Map<string, ToolView>();

  const finishSection = (section: SectionView | undefined) => {
    if (!section) return;
    // Promote a trailing assistant text item to the section's final message.
    const last = section.items[section.items.length - 1];
    if (last && last.type === "text" && last.stopReason !== "toolUse") {
      section.finalText = last.text;
      section.items.pop();
    }
    // Duration only makes sense for sections anchored at a user message.
    section.stats.durationMs = section.user && userTimestamp > 0 ? Math.max(0, lastTimestamp - userTimestamp) : 0;
    sections.push(section);
  };

  const ensureSection = (): SectionView => {
    if (!current) {
      current = { sid: `lead${sections.length}`, items: [], stats: { tools: 0, durationMs: 0, outTokens: 0, cost: 0 }, streaming: false };
    }
    return current;
  };

  for (const record of records) {
    if (record.kind === "user") {
      finishSection(current);
      userTimestamp = record.timestamp;
      lastTimestamp = record.timestamp;
      current = {
        sid: record.id,
        userEntryId: record.rewindable === false ? undefined : record.id,
        user: { text: record.text, images: record.images },
        items: [],
        stats: { tools: 0, durationMs: 0, outTokens: 0, cost: 0 },
        streaming: false,
      };
      continue;
    }

    if (record.kind === "assistant") {
      const section = ensureSection();
      lastTimestamp = Math.max(lastTimestamp, record.timestamp);
      section.stats.outTokens += record.outTokens;
      section.stats.cost += record.cost;
      for (const part of record.parts) {
        if (part.type === "thinking") {
          if (part.text.trim()) section.items.push({ type: "thinking", text: part.text });
        } else if (part.type === "text") {
          if (part.text.trim()) section.items.push({ type: "text", text: part.text, stopReason: record.stopReason });
        } else {
          const tool: ToolView = { callId: part.callId, name: part.name, args: part.args, status: "ok" };
          toolItems.set(part.callId, tool);
          section.items.push({ type: "tool", tool });
          section.stats.tools += 1;
        }
      }
      if (record.errorMessage) section.errorMessage = record.errorMessage;
      else if (record.stopReason === "aborted") section.errorMessage = "Run aborted";
      continue;
    }

    if (record.kind === "toolResult") {
      lastTimestamp = Math.max(lastTimestamp, record.timestamp);
      const tool = toolItems.get(record.callId);
      if (tool) {
        tool.resultText = record.text;
        tool.details = record.details;
        tool.status = record.isError || toolDetailsIndicateError(record.details) ? "error" : "ok";
      }
      continue;
    }

    // note
    if (record.tone === "summary") {
      // Summary notes (rewinds, branch summaries) are standalone and always visible.
      finishSection(current);
      current = undefined;
      sections.push({
        sid: record.id ?? `note${sections.length}`,
        items: [],
        stats: { tools: 0, durationMs: 0, outTokens: 0, cost: 0 },
        streaming: false,
        summaryNote: record.text,
      });
      continue;
    }
    // Notes (model changes, steering markers) do not extend a section's duration.
    const section = ensureSection();
    section.items.push({ type: "note", text: record.text, tone: record.tone });
  }

  finishSection(current);
  return sections;
}

export function toolDetailsIndicateError(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  const entry = details as Record<string, unknown>;
  return entry.aborted === true || entry.timedOut === true || (typeof entry.exitCode === "number" && entry.exitCode !== 0);
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

export function formatCost(cost: number): string {
  if (cost >= 10) return `$${cost.toFixed(0)}`;
  if (cost >= 0.0995) return `$${cost.toFixed(2)}`;
  if (cost >= 0.0005) return `$${cost.toFixed(3)}`;
  return "$0.00";
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function summarizeSectionStats(stats: SectionStats, options: { hasThinking: boolean }): string {
  const parts: string[] = [];
  if (stats.tools > 0) parts.push(`${stats.tools} tool ${stats.tools === 1 ? "call" : "calls"}`);
  if (options.hasThinking) parts.push("thinking");
  if (parts.length === 0) parts.push("details");
  if (stats.durationMs > 500) parts.push(formatDuration(stats.durationMs));
  if (stats.outTokens > 0) parts.push(`${formatTokens(stats.outTokens)} tok`);
  if (stats.cost > 0.0005) parts.push(formatCost(stats.cost));
  return parts.join(" · ");
}
