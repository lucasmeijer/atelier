import type { AgentRenderContext } from "./render-context.ts";
/** Renderer-friendly transcript model for the pi-backed runtime. */

import type { TurnTimingSummary } from "./turn-timing.ts";
import { Type, type Static } from "typebox";
import type { StopReason } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { isJsonObject, type JsonValue } from "@atelier/core";

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
  | { type: "text"; text: string; textSignature?: string }
  | { type: "toolCall"; callId: string; name: string; args: unknown };

export type AssistantTextPhase = "commentary" | "final_answer";

export function assistantTextPhase(textSignature?: string): AssistantTextPhase | undefined {
  if (!textSignature?.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(textSignature);
    if (!isJsonObject(parsed) || parsed.v !== 1) return undefined;
    return parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined;
  } catch {
    return undefined;
  }
}

export type TranscriptRecord =
  | { kind: "runStart"; turnEntryId: string; startedAt: number; timestamp: number }
  | { kind: "timing"; timing: TurnTimingSummary; turnEntryId?: string; outcome?: "completed" | "stopped"; timestamp: number }
  | { kind: "taskStart"; id: string; timestamp: number }
  | { kind: "user"; id: string; text: string; images: SessionImageRef[]; timestamp: number; rewindable?: boolean }
  | { kind: "assistant"; id: string; parts: AssistantPart[]; stopReason: StopReason; errorMessage?: string; timestamp: number }
  | { kind: "toolResult"; callId: string; text: string; images: SessionImageRef[]; isError: boolean; timestamp: number; details?: ToolViewDetails }
  | { kind: "note"; id?: string; text: string; tone: NoteTone; timestamp?: number };

// Shared by live completion and persisted transcript reconstruction.
export function assistantErrorText(message: { stopReason: string; errorMessage?: string }): string | undefined {
  return message.errorMessage || (message.stopReason === "aborted" ? "Run aborted" : message.stopReason === "error" ? "Provider request failed" : undefined);
}

export type NoteTone = "system" | "summary" | "warning" | "error";

const toolViewDetailsSchema = Type.Object({
  aborted: Type.Optional(Type.Boolean()),
  timedOut: Type.Optional(Type.Boolean()),
  exitCode: Type.Optional(Type.Number()),
  patch: Type.Optional(Type.String()),
  displayAnsi: Type.Optional(Type.String()),
  tmuxSession: Type.Optional(Type.String()),
});

export type ToolViewDetails = Static<typeof toolViewDetailsSchema> & { [key: string]: JsonValue | undefined };

export function isToolViewDetails(value: unknown): value is ToolViewDetails {
  if (!Value.Check(toolViewDetailsSchema, value)) return false;
  const definedEntries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return isJsonObject(Object.fromEntries(definedEntries));
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
  details?: ToolViewDetails;
  /** Timestamp of the assistant entry that issued this call. */
  issuedAt?: number;
}

interface TranscriptItemBase {
  timestamp?: number;
  anchor?: string;
  key: string;
  /** Rewind to immediately before this persisted session entry. */
  rewindEntryId?: string;
}

export type WorkingTranscriptItem = TranscriptItemBase & {
  type: "working";
  /** Initiating and steering entries whose activity belongs to this run. */
  inputEntryIds?: string[];
  startedAt: number;
  completedAt?: number;
  stoppedAt?: number;
  timing?: TurnTimingSummary;
  live?: boolean;
  items: TranscriptItem[];
};

export type TranscriptItem =
  | (TranscriptItemBase & { type: "extension"; render(ctx: AgentRenderContext): string })
  | (TranscriptItemBase & { type: "user"; text: string; images: SessionImageRef[] })
  | WorkingTranscriptItem
  | (TranscriptItemBase & { type: "thinking"; text: string; live?: boolean })
  | (TranscriptItemBase & { type: "text"; text: string; final: boolean; live?: boolean })
  | (TranscriptItemBase & { type: "tool"; tool: ToolView })
  | (TranscriptItemBase & { type: "note"; text: string; tone: NoteTone })
  | (TranscriptItemBase & { type: "error"; text: string });

export function findTranscriptItem(items: TranscriptItem[], key: string): TranscriptItem | undefined {
  for (const item of items) {
    if (item.key === key) return item;
    if (item.type === "working") {
      const nested = findTranscriptItem(item.items, key);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function isFinalAssistantStopReason(reason: StopReason): boolean {
  return reason === "stop" || reason === "length" || reason === "deferred";
}

type AssistantContentPart = { type: string; text?: string; textSignature?: string };

/** Select final-answer content once for both streaming promotion and persisted history. */
export function finalAssistantTextIndexes(parts: ReadonlyArray<AssistantContentPart>): number[] {
  const phased = parts.some((part) => part.type === "text" && assistantTextPhase(part.textSignature) !== undefined);
  return parts.flatMap((part, index) => part.type === "text"
    && (!phased || assistantTextPhase(part.textSignature) === "final_answer") ? [index] : []);
}

export function isFinalAssistantMessage(parts: ReadonlyArray<AssistantContentPart>, stopReason: StopReason): boolean {
  return isFinalAssistantStopReason(stopReason)
    && !parts.some((part) => part.type === "toolCall")
    && finalAssistantTextIndexes(parts).some((index) => Boolean(parts[index]!.text?.trim()));
}

export function finalAssistantText(parts: ReadonlyArray<AssistantContentPart>): string {
  return finalAssistantTextIndexes(parts).map((index) => parts[index]!.text ?? "").join("");
}

/** Run markers keep steering in one block; older unmarked history retains its user boundaries. */
export function buildTranscript(records: TranscriptRecord[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, ToolView>();
  const runStarts = new Set(records.filter((record) => record.kind === "runStart").map((record) => record.turnEntryId));
  let working: WorkingTranscriptItem | undefined;
  let runScoped = false;
  let lastTimestamp = 0;

  const appendActivity = (item: TranscriptItem, timestamp: number): void => {
    item.timestamp = timestamp;
    (working?.items ?? items).push(item);
  };
  const stopWorking = (timestamp: number): void => {
    if (working && working.completedAt === undefined) working.stoppedAt = Math.max(working.startedAt, timestamp);
    working = undefined;
    runScoped = false;
  };

  for (const [recordIndex, record] of records.entries()) {
    lastTimestamp = record.timestamp ?? lastTimestamp;
    if (record.kind === "runStart") {
      if (working?.key === `${record.turnEntryId}:working`) {
        working.startedAt = record.startedAt;
        runScoped = true;
      }
      continue;
    }
    if (record.kind === "timing") {
      const target = items.findLast((item) => item.type === "working"
        && (record.turnEntryId === undefined || item.key === `${record.turnEntryId}:working`));
      if (target?.type === "working") {
        target.timing = record.timing;
        const endedAt = target.startedAt + record.timing.elapsedMs;
        if (record.outcome === "stopped" || (record.outcome === undefined && target.stoppedAt !== undefined)) {
          target.stoppedAt = endedAt;
          target.completedAt = undefined;
        } else {
          target.completedAt = endedAt;
          target.stoppedAt = undefined;
        }
        if (working === target) { working = undefined; runScoped = false; }
      }
      continue;
    }
    if (record.kind === "user" || record.kind === "taskStart") {
      if (record.kind === "user") items.push({
        type: "user",
        timestamp: record.timestamp,
        key: record.id,
        rewindEntryId: record.rewindable === false ? undefined : record.id,
        text: record.text,
        images: record.images,
      });
      if (working && runScoped && !runStarts.has(record.id)) {
        working.inputEntryIds!.push(record.id);
        continue;
      }
      if (working) {
        if (runScoped) working.stoppedAt = Math.max(working.startedAt, record.timestamp);
        else working.completedAt = Math.max(working.startedAt, record.timestamp);
      }
      runScoped = false;
      working = { type: "working", timestamp: record.timestamp, key: `${record.id}:working`, inputEntryIds: [record.id], startedAt: record.timestamp, items: [] };
      items.push(working);
      continue;
    }

    if (record.kind === "assistant") {
      const final = isFinalAssistantMessage(record.parts, record.stopReason);
      const finalIndexes = new Set(final ? finalAssistantTextIndexes(record.parts) : []);
      let first = true;
      record.parts.forEach((part, index) => {
        const rewindEntryId = first ? record.id : undefined;
        if (part.type === "thinking" && part.text.trim()) {
          appendActivity({ type: "thinking", key: `${record.id}:thinking:${index}`, rewindEntryId, text: part.text }, record.timestamp);
          first = false;
        } else if (part.type === "text" && part.text.trim()) {
          const finalPart = finalIndexes.has(index);
          const item: TranscriptItem = { type: "text", timestamp: record.timestamp, key: `${record.id}:text:${index}`, rewindEntryId, text: part.text, final: finalPart };
          if (finalPart) items.push(item);
          else appendActivity(item, record.timestamp);
          first = false;
        } else if (part.type === "toolCall") {
          const tool: ToolView = { callId: part.callId, name: part.name, args: part.args, status: "ok", issuedAt: record.timestamp };
          tools.set(part.callId, tool);
          appendActivity({ type: "tool", key: `tool:${part.callId}`, rewindEntryId, tool }, record.timestamp);
          first = false;
        }
      });
      if (final) {
        if (!runScoped) {
          if (working) working.completedAt = Math.max(working.startedAt, record.timestamp);
          working = undefined;
        }
      } else {
        const errorText = assistantErrorText(record);
        const nextBoundary = record.stopReason === "error"
          ? records.slice(recordIndex + 1).find((next) =>
            next.kind === "assistant" || next.kind === "timing" || next.kind === "runStart"
            || (!runScoped && (next.kind === "user" || next.kind === "taskStart")))
          : undefined;
        const retry = record.stopReason === "error" && nextBoundary?.kind === "assistant";
        if (errorText) {
          const error: TranscriptItem = { type: "error", key: `${record.id}:${record.stopReason === "aborted" && !record.errorMessage ? "aborted" : "error"}`, text: errorText, timestamp: record.timestamp };
          if (retry) appendActivity(error, record.timestamp);
          else items.push(error);
        }
        if (!retry && (record.stopReason === "error" || record.stopReason === "aborted")) stopWorking(record.timestamp);
      }
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
      timestamp: lastTimestamp,
      key: record.id ?? `note:${recordIndex}`,
      rewindEntryId: record.id,
      text: record.text,
      tone: record.tone,
    });
  }
  stopWorking(lastTimestamp);
  return items;
}

export function toolDetailsIndicateError(details: ToolViewDetails | undefined): boolean {
  return details?.aborted === true || details?.timedOut === true || (details?.exitCode !== undefined && details.exitCode !== 0);
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
