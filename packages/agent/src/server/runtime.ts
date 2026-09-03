import { AtelierCoreError } from "@atelier/core";
import { createRealRuntime } from "./real-agent-runtime.ts";
import type { WorkspaceAgentRuntime, WorkspaceAgentRuntimeOptions } from "./runtime-types.ts";
import type { WorkspaceAgentConversationInfo } from "./session-store.ts";

export type { AgentLivePresentationSubscription, WorkspaceAgentRuntime } from "./runtime-types.ts";
export { subscribeWorkspaceViewBusy } from "./workspace-view-busy.ts";

const runtimes = new Map<string, Promise<WorkspaceAgentRuntime>>();
const removedWorkspaceIds = new Set<string>();
const closedConversationKeys = new Set<string>();

function runtimeKey(workspaceId: string, conversationId: string): string {
  return `${workspaceId}\u0000${conversationId}`;
}

export async function removeWorkspaceAgentRuntime(workspaceId: string, conversationId: string): Promise<void> {
  const key = runtimeKey(workspaceId, conversationId);
  closedConversationKeys.add(key);
  const runtime = runtimes.get(key);
  if (!runtime) return;
  runtimes.delete(key);
  await (await runtime).dispose();
}

/** Roll back a failed close after the durable session remained published. */
export function restoreWorkspaceAgentRuntime(workspaceId: string, conversationId: string): void {
  closedConversationKeys.delete(runtimeKey(workspaceId, conversationId));
}

export async function removeWorkspaceAgentRuntimes(workspaceId: string): Promise<void> {
  removedWorkspaceIds.add(workspaceId);
  const matching = [...runtimes.entries()].filter(([key]) => key.startsWith(`${workspaceId}\u0000`));
  for (const [key] of matching) runtimes.delete(key);
  const settled = await Promise.allSettled(matching.map(([, runtime]) => runtime));
  await Promise.all(settled.flatMap((result) => result.status === "fulfilled" ? [result.value.dispose()] : []));
}

export function getWorkspaceAgentRuntime(agent: WorkspaceAgentConversationInfo, options: WorkspaceAgentRuntimeOptions = {}): Promise<WorkspaceAgentRuntime> {
  if (removedWorkspaceIds.has(agent.workspaceId)) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${agent.workspaceId}`);
  const key = runtimeKey(agent.workspaceId, agent.conversationId);
  if (closedConversationKeys.has(key)) throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${agent.conversationId}`);
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createRealRuntime(agent, options).catch((error) => {
      runtimes.delete(key);
      throw error;
    });
    runtimes.set(key, runtime);
  }
  return runtime;
}
