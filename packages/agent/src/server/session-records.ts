import { contentText } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { significantCacheMissNotice, type CacheMiss } from "./cache-miss.ts";
import { assistantContextUsage, isToolViewDetails, type SessionImageRef, type TranscriptRecord } from "./transcript.ts";

interface ImageDimensions {
  width: number;
  height: number;
}

function imageDimensions(data: Uint8Array, mimeType: string): ImageDimensions | undefined {
  if (mimeType === "image/png" && data.length >= 24) return { width: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(16), height: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(20) };
  if (mimeType === "image/gif" && data.length >= 10) return { width: data[6]! | data[7]! << 8, height: data[8]! | data[9]! << 8 };
  if (mimeType === "image/bmp" && data.length >= 26) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  if (mimeType === "image/webp" && data.length >= 30 && String.fromCharCode(...data.slice(12, 16)) === "VP8X") {
    const width = 1 + data[24]! + (data[25]! << 8) + (data[26]! << 16);
    const height = 1 + data[27]! + (data[28]! << 8) + (data[29]! << 16);
    return { width, height };
  }
  if (mimeType === "image/jpeg") {
    for (let offset = 2; offset + 8 < data.length;) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1]!;
      const length = data[offset + 2]! << 8 | data[offset + 3]!;
      if (marker >= 0xc0 && marker <= 0xc3) return { height: data[offset + 5]! << 8 | data[offset + 6]!, width: data[offset + 7]! << 8 | data[offset + 8]! };
      offset += 2 + length;
    }
  }
  return undefined;
}

const sessionImagePartSchema = Type.Object({
  type: Type.Literal("image"),
  mimeType: Type.Optional(Type.Unknown()),
  data: Type.Optional(Type.Unknown()),
});
const sessionImageStringSchema = Type.String();
const sessionTextSignatureSchema = Type.String();

interface SessionAssistantTextPart {
  type: "text";
  text: string;
  textSignature?: string;
}

export function sessionContentImages(entry: { id: string; message?: { content?: unknown } }): SessionImageRef[] {
  if (!Array.isArray(entry.message?.content)) return [];
  const images: SessionImageRef[] = [];
  entry.message.content.forEach((part, contentIndex) => {
    if (!Value.Check(sessionImagePartSchema, part)) return;
    const mimeType = Value.Check(sessionImageStringSchema, part.mimeType) ? part.mimeType : undefined;
    const data = Value.Check(sessionImageStringSchema, part.data) ? part.data : undefined;
    const dimensions = data && mimeType ? imageDimensions(Buffer.from(data.slice(0, 87_384), "base64"), mimeType) : undefined;
    images.push({ entryId: entry.id, contentIndex, mimeType, ...dimensions });
  });
  return images;
}

function entryTimestamp(entry: { timestamp?: string }): number {
  const parsed = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function recordsFromSessionEntries(entries: any[], cacheMisses = new Map<any, CacheMiss>()): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  let lastModelChangeRecord: TranscriptRecord | undefined;
  let cacheNoticeInsertIndex: number | undefined;
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (!message) continue;
      if (message.role === "user") {
        records.push({ kind: "user", id: entry.id, text: contentText(message.content), images: sessionContentImages(entry), timestamp: entryTimestamp(entry), rewindable: entry.parentId !== null && entry.parentId !== undefined });
        cacheNoticeInsertIndex = records.length;
      } else if (message.role === "assistant") {
        const parts: any[] = [];
        for (const part of message.content ?? []) {
          if (part.type === "thinking") parts.push({ type: "thinking", text: part.thinking ?? "" });
          else if (part.type === "text") {
            const textPart: SessionAssistantTextPart = { type: "text", text: part.text ?? "" };
            if (Value.Check(sessionTextSignatureSchema, part.textSignature)) textPart.textSignature = part.textSignature;
            parts.push(textPart);
          }
          else if (part.type === "toolCall") parts.push({ type: "toolCall", callId: part.id, name: part.name, args: part.arguments });
        }
        records.push({
          kind: "assistant",
          id: entry.id,
          parts,
          stopReason: message.stopReason ?? "stop",
          errorMessage: message.errorMessage,
          timestamp: entryTimestamp(entry),
          usage: assistantContextUsage(message),
        });
        const notice = significantCacheMissNotice(cacheMisses.get(message));
        if (notice && message.stopReason !== "aborted" && message.stopReason !== "error") {
          const record: TranscriptRecord = { kind: "note", text: notice, tone: "warning", timestamp: entryTimestamp(entry) };
          if (cacheNoticeInsertIndex === undefined) records.push(record);
          else records.splice(cacheNoticeInsertIndex++, 0, record);
        }
      } else if (message.role === "toolResult") {
        const details = isToolViewDetails(message.details) ? message.details : undefined;
        records.push({ kind: "toolResult", callId: message.toolCallId, text: contentText(message.content), images: sessionContentImages(entry), isError: Boolean(message.isError), timestamp: entryTimestamp(entry), details });
      } else if (message.role === "bashExecution") {
        records.push({ kind: "note", id: entry.id, text: `\`$ ${message.command}\`\n\n\`\`\`\n${message.output ?? ""}\n\`\`\``, tone: "system", timestamp: entryTimestamp(entry) });
      } else if (message.role === "custom" && message.display) {
        records.push({ kind: "note", id: entry.id, text: contentText(message.content), tone: "summary", timestamp: entryTimestamp(entry) });
      } else if (message.role === "branchSummary") {
        records.push({ kind: "note", id: entry.id, text: `**Rewound** — summary of the abandoned branch:\n\n${message.summary ?? ""}`, tone: "summary", timestamp: entryTimestamp(entry) });
      }
      continue;
    }
    if (entry.type === "branch_summary") {
      records.push({ kind: "note", id: entry.id, text: `**Rewound** — summary of the abandoned branch:\n\n${entry.summary ?? ""}`, tone: "summary", timestamp: entryTimestamp(entry) });
      continue;
    }
    if (entry.type === "compaction") {
      records.push({ kind: "note", id: entry.id, text: "Context compacted", tone: "system", timestamp: entryTimestamp(entry) });
      continue;
    }
    if (entry.type === "custom_message" && entry.display) {
      records.push({ kind: "note", id: entry.id, text: contentText(entry.content), tone: "summary", timestamp: entryTimestamp(entry) });
      continue;
    }
    if (entry.type === "model_change") {
      if (records.length === 0) continue;
      const record: TranscriptRecord = { kind: "note", id: entry.id, text: `model → ${entry.provider}/${entry.modelId}`, tone: "system", timestamp: entryTimestamp(entry) };
      if (records.at(-1) === lastModelChangeRecord) records[records.length - 1] = record;
      else records.push(record);
      lastModelChangeRecord = record;
      continue;
    }
  }
  return records;
}

