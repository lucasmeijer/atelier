import type { ModelRef } from "./model-state.ts";
import type { SessionImageRef } from "./transcript.ts";
import { domId } from "./html.ts";

export interface AgentRenderContext {
  workspaceId: string;
  conversationId: string;
  model?: ModelRef;
  revealTarget?: string;
  branchId?: string;
}

export function agentConversationKey(conversationId: string): string {
  return `agent:${conversationId}`;
}

function prefix(ctx: AgentRenderContext): string {
  return domId("ag", ctx.workspaceId, ctx.conversationId);
}

export const ids = {
  pane: (ctx: AgentRenderContext) => `${prefix(ctx)}_pane`,
  transcript: (ctx: AgentRenderContext) => `${prefix(ctx)}_transcript`,
  systemPrompt: (ctx: AgentRenderContext) => `${prefix(ctx)}_system_prompt`,
  item: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_item`, key),
  workingItems: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_working_items`, key),
  itemText: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_itemtext`, key),
  itemTextStable: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_itemtext_stable`, key),
  itemTextTail: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_itemtext_tail`, key),
  itemSummaryContent: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_summary_content`, key),
  itemSummaryStatus: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_summary_status`, key),
  itemSummaryMetadata: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_summary_metadata`, key),
  detailFrame: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_detail`, key),
  stats: (ctx: AgentRenderContext) => `${prefix(ctx)}_stats`,
  actions: (ctx: AgentRenderContext) => `${prefix(ctx)}_actions`,
  abortForm: (ctx: AgentRenderContext) => `${prefix(ctx)}_abort_form`,
  attachRow: (ctx: AgentRenderContext) => `${prefix(ctx)}_attach`,
  input: (ctx: AgentRenderContext) => `${prefix(ctx)}_input`,
  draftAttachRow: (draftId: string) => domId("agent_draft_attach", draftId),
  draftChip: (draftId: string, attachmentId: string) => domId("agent_draft_chip", draftId, attachmentId),
  notices: (ctx: AgentRenderContext) => `${prefix(ctx)}_notices`,
};

export function agentPath(ctx: AgentRenderContext, suffix: string): string {
  return `/workspaces/${encodeURIComponent(ctx.workspaceId)}/agents/${encodeURIComponent(ctx.conversationId)}${suffix}`;
}

export function transcriptItemPath(ctx: AgentRenderContext, key: string, query = ""): string {
  return `${agentPath(ctx, `/transcript-items/${encodeURIComponent(key)}`)}${query}`;
}

export function sessionImageUrl(ctx: AgentRenderContext, image: SessionImageRef): string {
  return `${agentPath(ctx, "")}/session-images/${encodeURIComponent(image.entryId)}/${image.contentIndex}`;
}
