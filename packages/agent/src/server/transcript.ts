/** Flat, renderer-friendly transcript model for the pi-backed runtime. */

export interface ImageRef {
  mimeType: string;
  data: string;
}

export interface SessionImageRef {
  entryId: string;
  contentIndex: number;
  mimeType?: string;
  width?: number;
  height?: number;
}

type AssistantPart =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "toolCall"; callId: string; name: string; args: unknown };

export type TranscriptRecord =
  | { kind: "user"; id: string; text: string; images: SessionImageRef[]; timestamp: number; rewindable?: boolean }
  | { kind: "assistant"; id: string; parts: AssistantPart[]; stopReason: string; errorMessage?: string; timestamp: number }
  | { kind: "toolResult"; callId: string; text: string; images: SessionImageRef[]; isError: boolean; timestamp: number; details?: unknown }
  | { kind: "note"; id?: string; text: string; tone: NoteTone; timestamp?: number };

export type NoteTone = "system" | "summary" | "warning" | "error";

export interface ToolViewDetails {
  aborted?: unknown;
  timedOut?: unknown;
  exitCode?: unknown;
  patch?: unknown;
  displayAnsi?: unknown;
}

export interface ToolView {
  callId: string;
  name: string;
  args: unknown;
  status: "streaming" | "running" | "ok" | "error";
  resultText?: string;
  resultImages?: SessionImageRef[];
  argsStream?: string;
  tmuxSession?: string;
  terminalVisible?: boolean;
  startedAt?: number;
  timeoutSeconds?: number;
  durationMs?: number;
  tokenCount?: number;
  details?: unknown;
  /** Timestamp of the assistant entry that issued this call. */
  issuedAt?: number;
}

interface TranscriptItemBase {
  key: string;
  /** Rewind to immediately before this persisted session entry. */
  rewindEntryId?: string;
}

export type TranscriptItem =
  | (TranscriptItemBase & { type: "user"; text: string; images: SessionImageRef[] })
  | (TranscriptItemBase & { type: "thinking"; text: string; live?: boolean })
  | (TranscriptItemBase & { type: "text"; text: string; final: boolean; live?: boolean })
  | (TranscriptItemBase & { type: "tool"; tool: ToolView })
  | (TranscriptItemBase & { type: "note"; text: string; tone: NoteTone })
  | (TranscriptItemBase & { type: "error"; text: string });

/** Convert persisted records into one ordered stream; there is intentionally no turn/section layer. */
export function buildTranscript(records: TranscriptRecord[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, ToolView>();

  for (const record of records) {
    if (record.kind === "user") {
      items.push({
        type: "user",
        key: record.id,
        rewindEntryId: record.rewindable === false ? undefined : record.id,
        text: record.text,
        images: record.images,
      });
      continue;
    }

    if (record.kind === "assistant") {
      const hasTools = record.parts.some((part) => part.type === "toolCall");
      let first = true;
      record.parts.forEach((part, index) => {
        const rewindEntryId = first ? record.id : undefined;
        if (part.type === "thinking" && part.text.trim()) {
          items.push({ type: "thinking", key: `${record.id}:thinking:${index}`, rewindEntryId, text: part.text });
          first = false;
        } else if (part.type === "text" && part.text.trim()) {
          items.push({ type: "text", key: `${record.id}:text:${index}`, rewindEntryId, text: part.text, final: !hasTools && record.stopReason !== "toolUse" });
          first = false;
        } else if (part.type === "toolCall") {
          const tool: ToolView = { callId: part.callId, name: part.name, args: part.args, status: "ok", issuedAt: record.timestamp };
          tools.set(part.callId, tool);
          items.push({ type: "tool", key: `tool:${part.callId}`, rewindEntryId, tool });
          first = false;
        }
      });
      if (record.errorMessage) items.push({ type: "error", key: `${record.id}:error`, text: record.errorMessage });
      else if (record.stopReason === "aborted") items.push({ type: "error", key: `${record.id}:aborted`, text: "Run aborted" });
      continue;
    }

    if (record.kind === "toolResult") {
      const tool = tools.get(record.callId);
      if (tool) {
        tool.resultText = record.text;
        if (record.images.length) tool.resultImages = record.images;
        tool.details = record.details;
        tool.status = record.isError || toolDetailsIndicateError(record.details) ? "error" : "ok";
        if (tool.issuedAt && record.timestamp) tool.durationMs = Math.max(0, record.timestamp - tool.issuedAt);
      }
      continue;
    }

    items.push({
      type: "note",
      key: record.id ?? `note:${items.length}`,
      rewindEntryId: record.id,
      text: record.text,
      tone: record.tone,
    });
  }
  return items;
}

export function toolDetailsIndicateError(details: unknown): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  // SAFETY: ToolViewDetails only names optional properties with unknown values.
  const entry = details as ToolViewDetails;
  return entry.aborted === true || entry.timedOut === true || (typeof entry.exitCode === "number" && entry.exitCode !== 0);
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(".0", "")}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(".0", "")}k`;
  return String(count);
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function formatCost(cost: number): string {
  if (cost >= 10) return `$${cost.toFixed(0)}`;
  if (cost >= 0.0995) return `$${cost.toFixed(2)}`;
  if (cost >= 0.0005) return `$${cost.toFixed(3)}`;
  return "$0.00";
}
