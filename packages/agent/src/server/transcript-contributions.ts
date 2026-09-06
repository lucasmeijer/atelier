import type { TranscriptItem } from "./transcript.ts";

export interface AgentTranscriptContext {
  activeTurnEntryId?: string;
}
export interface AgentTranscriptAddition {
  item: Extract<TranscriptItem, { type: "extension" }>;
  /** Omit for an independently timed row outside model activity. */
  placement?: { turnEntryId: string; relation: "before-turn" | "during-turn" };
}
export type AgentTranscriptAnchor = {
  anchor: string;
  target: { toolCallId: string } | { finalText: string; completedAt: number };
};

/** Additive data only. The adapter never receives or rewrites host transcript items.
 * Anchors are resolved by the host for snapshots, lazy details and reveal requests;
 * they do not replace live tool/text DOM while it is streaming. */
export interface AgentTranscriptSnapshot {
  rows: AgentTranscriptAddition[];
  anchors: AgentTranscriptAnchor[];
}

export function applyTranscriptContributions(items: TranscriptItem[], snapshot: AgentTranscriptSnapshot, context: AgentTranscriptContext): TranscriptItem[] {
  const annotate = (items: TranscriptItem[]): TranscriptItem[] => items.map((item) => {
    if (item.type === "working") return { ...item, items: annotate(item.items) };
    const anchor = snapshot.anchors.find(({ target }) => "toolCallId" in target
      ? item.type === "tool" && item.tool.callId === target.toolCallId
      : item.type === "text" && item.final && item.text === target.finalText && (item.timestamp ?? 0) <= target.completedAt)?.anchor;
    return anchor ? { ...item, anchor } : item;
  });
  const time = (item: TranscriptItem) => item.timestamp ?? (item.type === "working" ? item.startedAt : 0);
  const result = annotate(items);
  for (const { item, placement } of snapshot.rows) {
    const working = placement && result.find((candidate) => candidate.type === "working" && (candidate.key === `${placement.turnEntryId}:working` || (candidate.live && placement.turnEntryId === context.activeTurnEntryId)));
    if (working?.type === "working" && placement?.relation === "during-turn") {
      working.items = [...working.items, item].sort((a, b) => time(a) - time(b));
    } else if (working) result.splice(result.indexOf(working), 0, item);
    else {
      const next = result.findIndex((candidate) => time(candidate) > time(item));
      result.splice(next < 0 ? result.length : next, 0, item);
    }
  }
  return result;
}
