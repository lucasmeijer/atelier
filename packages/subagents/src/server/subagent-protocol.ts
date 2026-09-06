import { Type } from "typebox";
import type { SubagentMessage, SubagentRecord, SubagentState } from "./subagent-runtime.ts";

// Codex MultiAgentV2, 574a36ff99f0807a24f5b043f593122bf151908d.
// See codex-rs/core/src/context/inter_agent{,_completion}_message.rs and protocol/src/protocol.rs.
export function agentPath(state: SubagentState, id: string): string {
  const agent = state.agents.find((candidate) => candidate.id === id);
  return agent ? `${agentPath(state, agent.parentId)}/${agent.taskName}` : "/root";
}
export function messageEnvelope(state: SubagentState, message: SubagentMessage): string {
  const type = message.kind === "task" ? "NEW_TASK" : message.kind === "completion" ? "FINAL_ANSWER" : "MESSAGE";
  return `Message Type: ${type}\nTask name: ${agentPath(state, message.to)}\nSender: ${agentPath(state, message.from)}\nPayload:\n${message.text}`;
}
export function codexStatus(agent: SubagentRecord) {
  switch (agent.status) {
    case "starting": return "pending_init";
    case "running": return "running";
    case "interrupted": return "interrupted";
    case "closed": return "shutdown";
    case "failed": return { errored: agent.result ?? "Agent failed." };
    case "completed": return { completed: agent.result ?? null };
  }
}
export const agentMessageSchema = Type.Object({
  type: Type.Literal("agent_message"), author: Type.String(), recipient: Type.String(),
  content: Type.Array(Type.Object({ type: Type.Literal("input_text"), text: Type.String() })),
});
export type AgentMessageInput = ReturnType<typeof modelMessage>;
export function modelMessage(state: SubagentState, message: SubagentMessage) {
  return { type: "agent_message" as const, author: agentPath(state, message.from), recipient: agentPath(state, message.to), content: [{ type: "input_text" as const, text: messageEnvelope(state, message) }] };
}
export function parseForkTurns(value = "all"): string {
  const normalized = value.trim().toLowerCase() || "all";
  if (normalized === "all" || normalized === "none") return normalized;
  if (!/^\+?\d+$/.test(normalized) || !Number.isSafeInteger(Number(normalized)) || Number(normalized) < 1) throw new Error("fork_turns must be `none`, `all`, or a positive integer string");
  return String(Number(normalized));
}
