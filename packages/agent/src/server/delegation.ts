import type { AgentTranscriptSnapshot } from "./transcript-contributions.ts";
import { AtelierCoreError, type AtelierEventBus, type JsonObject } from "@atelier/core";
import type { AgentSession, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRenderContext } from "./render-context.ts";
import { listWorkspaceAgentConversations, type WorkspaceAgentConversationInfo } from "./session-store.ts";
import type { ToolView, TranscriptItem, TranscriptRecord } from "./transcript.ts";

export interface AgentDelegationContext {
  agent: WorkspaceAgentConversationInfo;
  events?: AtelierEventBus;
}

/** Created for each conversion, retained through provider serialization and request preparation.
 * A prepared request is NOT a provider acknowledgement. */
export interface AgentModelRequestTransform {
  messages?(messages: any[]): any[] | Promise<any[]>;
  payload?(payload: JsonObject, model: { api: string }): JsonObject | Promise<JsonObject>;
  prepared?(model: { api: string }): void | Promise<void>;
}

export interface AgentSessionAttachment {
  createModelRequest?(): AgentModelRequestTransform;
  dispose(): void | Promise<void>;
}

export interface AgentDelegationTranscript {
  snapshot(): AgentTranscriptSnapshot;
  subscribe(invalidate: () => void): () => void;
}

export interface AgentSessionPreparation {
  prompt?: string[];
  /** Resolved after session restoration and refreshed when model/thinking changes. */
  modelPrompt?(modelId: string | undefined, thinkingLevel: string): string[];
  tools?: ToolDefinition<any, any>[];
  outputSchemas?: ReadonlyMap<string, unknown>;
  model?: { provider: string; id: string };
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Called after the durable history is opened, before session construction. */
  seedHistory?(manager: SessionManager): void;
  /** Called before the session is exposed to callers or inference can start. */
  attach?(session: AgentSession): AgentSessionAttachment;
  transcript?(session: AgentSession): AgentDelegationTranscript;
}

export interface AgentToolPresentation {
  summary(tool: ToolView): string | undefined;
  detail(ctx: AgentRenderContext, tool: ToolView): string | undefined;
}

export interface AgentDelegation {
  prepare(context: AgentDelegationContext): Promise<AgentSessionPreparation> | AgentSessionPreparation;
  resolveConversation(workspaceId: string, conversationId: string, events?: AtelierEventBus): Promise<WorkspaceAgentConversationInfo | undefined>;
  /** After the closed runtime stops, before archival. Not called for plain unloading. */
  closingConversation(workspaceId: string, conversationId: string): Promise<void>;
  /** Runs before any runtime in the workspace is disposed. */
  removingWorkspace(workspaceId: string): Promise<void>;
  projectSessionEntry(entry: any): TranscriptRecord[] | undefined;
  toolPresentations?: ReadonlyMap<string, AgentToolPresentation>;
}

/** One trusted Pi integration, installed by the web composition root before runtimes start.
 * This is not a plugin registry: there is no ordering, merging, or override policy.
 * Pi session/history access is intentional; the integration must not replace host request hooks. */
export let agentDelegation: AgentDelegation | undefined;
export function configureAgentDelegation(delegation: AgentDelegation | undefined): void {
  agentDelegation = delegation;
}

export async function resolveAgentConversation(workspaceId: string, conversationId: string, events?: AtelierEventBus): Promise<WorkspaceAgentConversationInfo> {
  const root = (await listWorkspaceAgentConversations(workspaceId)).find((agent) => agent.conversationId === conversationId);
  if (root) return root;
  const child = await agentDelegation?.resolveConversation(workspaceId, conversationId, events);
  if (child) return child;
  throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${conversationId}`);
}
