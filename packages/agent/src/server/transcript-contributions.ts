import type { TranscriptItem } from "./transcript.ts";

export interface AgentTranscriptAddition {
  item: Extract<TranscriptItem, { type: "extension" }>;
  /** This arrival is still awaiting its first model request. Count it only in its containing run. */
  unread?: boolean;
  /** Omit for an independently timed row outside model activity. */
  placement?: { turnEntryId: string; relation: "before-turn" | "during-turn" }
    /** Join the run active at the row timestamp; otherwise remain independently timed. */
    | { relation: "during-activity" };
}
export type AgentTranscriptAnchor = {
  anchor: string;
  target: { toolCallId: string } | { finalText: string; completedAt: number };
};

/** Declarative data only. The adapter never receives or rewrites host transcript items.
 * Anchors are resolved by the host for snapshots, lazy details and reveal requests;
 * they do not replace live tool/text DOM while it is streaming. */
export interface AgentTranscriptSnapshot {
  rows: AgentTranscriptAddition[];
  anchors: AgentTranscriptAnchor[];
  /** Entries before this persisted marker are copied context; entries after it are local activity. */
  inheritedContext?: { boundaryEntryId: string; source: string };
}

export function applyTranscriptContributions(items: TranscriptItem[], snapshot: AgentTranscriptSnapshot): TranscriptItem[] {
  const annotate = (items: TranscriptItem[]): TranscriptItem[] => items.map((item) => {
    if (item.type === "working") return { ...item, unreadQueueCount: 0, items: annotate(item.items) };
    const anchor = snapshot.anchors.find(({ target }) => "toolCallId" in target
      ? item.type === "tool" && item.tool.callId === target.toolCallId
      : item.type === "text" && item.final && item.text === target.finalText && (item.timestamp ?? 0) <= target.completedAt)?.anchor;
    return anchor ? { ...item, anchor } : item;
  });
  const time = (item: TranscriptItem) => item.timestamp ?? (item.type === "working" ? item.startedAt : 0);
  const result = annotate(items);
  for (const { item, placement, unread } of snapshot.rows) {
    const working = placement && result.findLast((candidate) => {
      if (candidate.type !== "working") return false;
      if (placement.relation === "during-activity") {
        const end = candidate.live ? Infinity : candidate.completedAt ?? candidate.stoppedAt ?? candidate.startedAt;
        return time(item) >= candidate.startedAt && time(item) < end;
      }
      return candidate.key === `${placement.turnEntryId}:working` || candidate.inputEntryIds?.includes(placement.turnEntryId);
    });
    if (working?.type === "working" && placement?.relation !== "before-turn") {
      working.items = [...working.items, item].sort((a, b) => time(a) - time(b));
      if (unread) working.unreadQueueCount = (working.unreadQueueCount ?? 0) + 1;
    } else if (working) result.splice(result.indexOf(working), 0, item);
    else {
      const next = result.findIndex((candidate) => time(candidate) > time(item));
      result.splice(next < 0 ? result.length : next, 0, item);
    }
  }
  return result;
}
