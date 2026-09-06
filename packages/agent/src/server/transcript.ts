import type { SubagentMessage } from "./subagent-runtime.ts";
import type { SubagentDelivery } from "./subagent-delivery.ts";
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

export interface SubagentTranscriptMessage {
  dispatchMode?: SubagentMessage["dispatchMode"];
  dispatchReason?: SubagentMessage["dispatchReason"];
  deliveredEnvelope?: string;
  deliveredFormat?: "agent_message" | "user";
  id: string; rootId: string; agentId: string; path: string; kind: string;
  delivery: "queued" | "delivered" | "failed";
}

export type TranscriptRecord =
  | { kind: "timing"; timing: TurnTimingSummary; timestamp: number }
  | { kind: "taskStart"; id: string; timestamp: number }
  | { kind: "user"; id: string; text: string; images: SessionImageRef[]; timestamp: number; rewindable?: boolean }
  | { kind: "assistant"; id: string; parts: AssistantPart[]; stopReason: StopReason; errorMessage?: string; timestamp: number }
  | { kind: "toolResult"; callId: string; text: string; images: SessionImageRef[]; isError: boolean; timestamp: number; details?: ToolViewDetails }
  | { kind: "note"; id?: string; text: string; tone: NoteTone; timestamp?: number };

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
  communicationId?: string;
  key: string;
  /** Rewind to immediately before this persisted session entry. */
  rewindEntryId?: string;
}

export type WorkingTranscriptItem = TranscriptItemBase & {
  type: "working";
  startedAt: number;
  completedAt?: number;
  stoppedAt?: number;
  timing?: TurnTimingSummary;
  live?: boolean;
  items: TranscriptItem[];
};

export type TranscriptItem =
  | (TranscriptItemBase & { type: "user"; text: string; images: SessionImageRef[] })
  | WorkingTranscriptItem
  | (TranscriptItemBase & { type: "thinking"; text: string; live?: boolean })
  | (TranscriptItemBase & { type: "text"; text: string; final: boolean; live?: boolean })
  | (TranscriptItemBase & { type: "tool"; tool: ToolView })
  | (TranscriptItemBase & { type: "note"; text: string; tone: NoteTone; communication?: SubagentTranscriptMessage; modelDelivery?: SubagentDelivery })
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

export function isFinalAssistantMessage(parts: ReadonlyArray<{ type: string; text?: string; textSignature?: string }>, stopReason: StopReason): boolean {
  const textParts = parts.filter((part) => part.type === "text");
  const hasPhasedText = textParts.some((part) => assistantTextPhase(part.textSignature) !== undefined);
  const hasFinalText = textParts.some((part) => Boolean(part.text?.trim())
    && (!hasPhasedText || assistantTextPhase(part.textSignature) === "final_answer"));
  return isFinalAssistantStopReason(stopReason)
    && hasFinalText
    && !parts.some((part) => part.type === "toolCall");
}

export function finalAssistantText(parts: ReadonlyArray<{ type: string; text?: string; textSignature?: string }>): string {
  const textParts = parts.filter((part) => part.type === "text");
  const hasPhasedText = textParts.some((part) => assistantTextPhase(part.textSignature) !== undefined);
  return textParts
    .filter((part) => !hasPhasedText || assistantTextPhase(part.textSignature) === "final_answer")
    .map((part) => part.text ?? "")
    .join("");
}

/** Convert persisted records into user turns with synthetic working sections. */
export function buildTranscript(records: TranscriptRecord[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, ToolView>();
  let working: WorkingTranscriptItem | undefined;
  let lastTimestamp = 0;
  let lastWorkingActivityAt = 0;

  const recordWorkingActivity = (timestamp: number): void => {
    if (working) lastWorkingActivityAt = Math.max(working.startedAt, timestamp);
  };
  const appendActivity = (item: TranscriptItem, timestamp: number): void => {
    item.timestamp = timestamp;
    (working?.items ?? items).push(item);
    recordWorkingActivity(timestamp);
  };
  const stopWorking = (timestamp: number): void => {
    if (working && working.completedAt === undefined) working.stoppedAt = Math.max(working.startedAt, timestamp);
    working = undefined;
  };

  for (const [recordIndex, record] of records.entries()) {
    lastTimestamp = record.timestamp ?? lastTimestamp;
    if (record.kind === "timing") {
      const latestWorking = items.findLast((item) => item.type === "working");
      if (latestWorking) latestWorking.timing = record.timing;
      continue;
    }
    if (record.kind === "user" || record.kind === "taskStart") {
      stopWorking(record.timestamp);
      if (record.kind === "user") items.push({
        type: "user",
        timestamp: record.timestamp,
        key: record.id,
        rewindEntryId: record.rewindable === false ? undefined : record.id,
        text: record.text,
        images: record.images,
      });
      working = { type: "working", timestamp: record.timestamp, key: `${record.id}:working`, startedAt: record.timestamp, items: [] };
      lastWorkingActivityAt = record.timestamp;
      items.push(working);
      continue;
    }

    if (record.kind === "assistant") {
      const final = isFinalAssistantMessage(record.parts, record.stopReason);
      const hasPhasedText = record.parts.some((part) => part.type === "text" && assistantTextPhase(part.textSignature) !== undefined);
      let first = true;
      record.parts.forEach((part, index) => {
        const rewindEntryId = first ? record.id : undefined;
        if (part.type === "thinking" && part.text.trim()) {
          appendActivity({ type: "thinking", key: `${record.id}:thinking:${index}`, rewindEntryId, text: part.text }, record.timestamp);
          first = false;
        } else if (part.type === "text" && part.text.trim()) {
          const finalPart = final && (!hasPhasedText || assistantTextPhase(part.textSignature) === "final_answer");
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
        if (working) working.completedAt = lastWorkingActivityAt;
        working = undefined;
      } else {
        if (record.errorMessage) appendActivity({ type: "error", key: `${record.id}:error`, text: record.errorMessage }, record.timestamp);
        else if (record.stopReason === "aborted") appendActivity({ type: "error", key: `${record.id}:aborted`, text: "Run aborted" }, record.timestamp);
        if (record.stopReason === "error" || record.stopReason === "aborted") stopWorking(record.timestamp);
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
        recordWorkingActivity(record.timestamp);
      }
      continue;
    }

    appendActivity({
      type: "note",
      key: record.id ?? `note:${recordIndex}`,
      rewindEntryId: record.id,
      text: record.text,
      tone: record.tone,
    }, lastTimestamp);
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
