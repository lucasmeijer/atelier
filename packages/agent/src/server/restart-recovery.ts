import type { AtelierEventBus } from "@atelier/core";
import { workspaceRoot } from "@atelier/workspace";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { getWorkspaceAgentRuntime } from "./runtime.ts";
import { listWorkspaceAgentConversations, type WorkspaceAgentConversationInfo } from "./session-store.ts";
import { isFinalAssistantStopReason } from "./transcript.ts";

export const atelierRestartPrompt = "The atelier host had to restart. Your execution environment did not restart. You may continue if you had any unfinished business";

/** A non-empty active branch needs recovery unless its last message is a terminal assistant response. */
export function agentSessionNeedsRestartRecovery(entries: readonly SessionEntry[]): boolean {
  const latestMessage = entries.findLast((entry) => entry.type === "message");
  if (!latestMessage || latestMessage.type !== "message") return false;
  const message = latestMessage.message;
  return message.role !== "assistant" || !isFinalAssistantStopReason(message.stopReason ?? "stop");
}

function persistedSessionNeedsRestartRecovery(agent: WorkspaceAgentConversationInfo): boolean {
  const sessionManager = SessionManager.open(agent.path, dirname(agent.path), workspaceRoot);
  return agentSessionNeedsRestartRecovery(sessionManager.getBranch());
}

async function resumeAgent(agent: WorkspaceAgentConversationInfo, events: AtelierEventBus): Promise<void> {
  if (!persistedSessionNeedsRestartRecovery(agent)) return;
  const runtime = await getWorkspaceAgentRuntime(agent, { events });
  await runtime.submit(atelierRestartPrompt);
}

export async function resumeInterruptedAgentSessions(workspaces: readonly { id: string; parked: boolean }[], events: AtelierEventBus): Promise<void> {
  const runningWorkspaces = workspaces.filter((workspace) => !workspace.parked);
  const listings = await Promise.allSettled(runningWorkspaces.map((workspace) => listWorkspaceAgentConversations(workspace.id)));
  const conversations = listings.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    console.error(`Could not inspect Agent sessions in Workspace ${runningWorkspaces[index]!.id}`, result.reason);
    return [];
  });
  const results = await Promise.allSettled(conversations.map(async (conversation) => await resumeAgent(conversation, events)));
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    const conversation = conversations[index]!;
    console.error(`Could not resume interrupted Agent session ${conversation.workspaceId}/${conversation.conversationId}`, result.reason);
  });
}
