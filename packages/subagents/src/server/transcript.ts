import { type AgentTranscriptSnapshot, type AgentTranscriptAnchor, type AgentTranscriptAddition, type AgentDelegationTranscript, type TranscriptItem } from "@atelier/agent/server";
import { subagentSnapshot, subscribeSubagentChanges } from "./subagents.ts";
import { inheritedContextEntryType } from "./fork-history.ts";
import { agentPath } from "./subagent-protocol.ts";
import { parseSubagentDelivery, queuedModelDelivery, subagentDeliveryType } from "./subagent-delivery.ts";
import { renderCommunication, type CommunicationView } from "./render-transcript.ts";

function communicationItem(view: CommunicationView & { timestamp: number; anchor?: string }): Extract<TranscriptItem, { type: "extension" }> {
  return { type: "extension", key: view.key, timestamp: view.timestamp, anchor: view.anchor, render: (ctx) => renderCommunication(ctx, view) };
}

export class SubagentTranscript implements AgentDelegationTranscript {
  constructor(private workspaceId: string, private conversationId: string, private session: any) {}
  subscribe(invalidate: () => void): () => void {
    return subscribeSubagentChanges((workspaceId) => { if (workspaceId === this.workspaceId) invalidate(); });
  }
  snapshot(): AgentTranscriptSnapshot {
    const state = subagentSnapshot(this.workspaceId);
    const own = state.agents.find((agent) => agent.id === this.conversationId);
    const branch = this.session.sessionManager.getBranch();
    const deliveries = branch.filter((entry: any) => entry.type === "custom" && entry.customType === subagentDeliveryType)
      .map((entry: any) => ({ id: entry.id, timestamp: Date.parse(entry.timestamp), batch: parseSubagentDelivery(entry.data, state.messages) }));
    const readMessageIds = new Set<string>();
    const immediate = new Map<string, { envelope: string; format: "agent_message" | "user" }>();
    for (const { batch } of deliveries) {
      for (const message of batch.messages) {
        readMessageIds.add(message.id);
        if (message.immediate) immediate.set(message.id, { envelope: message.envelope, format: batch.format ?? "agent_message" });
      }
    }
    const inheritedIds = new Set(branch.filter((entry: any) => entry.type === "custom_message" && entry.customType === "subagent").map((entry: any) => entry.details?.subagentMessageId));
    const additions: AgentTranscriptAddition[] = state.messages.filter((message) => (message.to === this.conversationId || inheritedIds.has(message.id)) && ["task", "message", "completion"].includes(message.kind)).map((message) => ({
      unread: message.to === this.conversationId && message.delivery !== "failed" && !readMessageIds.has(message.id),
      placement: message.dispatchReason === "working" || message.dispatchReason === "waiting" ? { relation: "during-activity" as const } : undefined,
      item: communicationItem({
        key: `communication:${message.id}`, text: message.text, anchor: message.id,
        timestamp: Date.parse(message.timestamp),
        communication: { id: message.id, agentId: message.from, path: agentPath(state, message.from), kind: message.kind, delivery: message.delivery, dispatchMode: message.dispatchMode, dispatchReason: message.dispatchReason, queueSizeOnArrival: message.queueSizeOnArrival, immediateRead: immediate.get(message.id) },
      }),
    }));
    const anchors: AgentTranscriptAnchor[] = [];
    for (const message of state.messages.filter((message) => message.from === this.conversationId)) {
      if (message.toolCallId) anchors.push({ anchor: message.id, target: { toolCallId: message.toolCallId } });
      if (message.kind === "completion") {
        anchors.push({ anchor: message.id, target: { finalText: message.text, completedAt: Date.parse(message.timestamp) } });
        if (message.text.startsWith("[completed] ")) anchors.push({ anchor: message.id, target: { finalText: message.text.slice("[completed] ".length), completedAt: Date.parse(message.timestamp) } });
      }
    }
    for (const entry of deliveries) {
      const batch = queuedModelDelivery(entry.batch);
      if (!batch) continue;
      const source = batch.messages.length === 1 ? state.messages.find((message) => message.id === batch.messages[0]!.id)! : undefined;
      const item = communicationItem({ key: entry.id, timestamp: entry.timestamp, modelDelivery: batch, queuedSource: source ? { path: agentPath(state, source.from), kind: source.kind } : undefined });
      additions.push({ item, placement: { turnEntryId: batch.turnEntryId, relation: batch.duringActivity ? "during-turn" : "before-turn" } });
    }
    const boundary = branch.find((entry: any) => entry.type === "custom" && entry.customType === inheritedContextEntryType);
    return { rows: additions, anchors, inheritedContext: boundary && {
      boundaryEntryId: boundary.id, source: agentPath(state, own!.parentId),
    } };
  }
}
