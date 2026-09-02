import { AtelierCoreError, type AtelierEventBus } from "@atelier/core";
import type { WorkspaceAgentViewInvalidatedEvent } from "@atelier/workspace";
import type { maybeNameAgentFromPrompt } from "./agent-title-suggestion.ts";
import { getWorkspaceAgentRuntime } from "./runtime.ts";
import { listWorkspaceAgentConversations, type WorkspaceAgentConversationInfo } from "./session-store.ts";

export interface AgentRouteOptions {
  events?: AtelierEventBus;
  getRuntime?: typeof getWorkspaceAgentRuntime;
  suggestTitleFromPrompt?: typeof maybeNameAgentFromPrompt;
}

export type AgentRouteHandler = (request: Request, url: URL, options: AgentRouteOptions) => Promise<Response | undefined>;

export function matchRoute(url: URL, pattern: RegExp): string[] | undefined {
  const result = url.pathname.match(pattern);
  return result ? result.slice(1).map(decodeURIComponent) : undefined;
}

export async function invalidateAgentView(options: AgentRouteOptions, workspaceId: string, conversationId: string, exceptConnectionId?: string, html?: string): Promise<void> {
  const event: WorkspaceAgentViewInvalidatedEvent = { workspaceId, conversationId };
  if (exceptConnectionId) event.exceptConnectionId = exceptConnectionId;
  if (html) event.html = html;
  await options.events?.emit("workspace_agent_view_invalidated", event);
}

export async function resolveAgentRuntime(agent: WorkspaceAgentConversationInfo, options: AgentRouteOptions): ReturnType<typeof getWorkspaceAgentRuntime> {
  return await (options.getRuntime ?? getWorkspaceAgentRuntime)(agent, { events: options.events });
}

export async function requireAgentConversation(workspaceId: string, conversationId: string): Promise<WorkspaceAgentConversationInfo> {
  const conversations = await listWorkspaceAgentConversations(workspaceId);
  const conversation = conversations.find((candidate) => candidate.conversationId === conversationId);
  if (!conversation) throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${conversationId}`);
  return conversation;
}

export async function requireAgentRuntime(workspaceId: string, conversationId: string, options: AgentRouteOptions): ReturnType<typeof getWorkspaceAgentRuntime> {
  return await resolveAgentRuntime(await requireAgentConversation(workspaceId, conversationId), options);
}
