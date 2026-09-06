import { assistantTextPhase, isFinalAssistantMessage } from "@atelier/agent/server";
import { isJsonObject } from "@atelier/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { contentText } from "@earendil-works/pi-ai";
import { parseForkTurns } from "./subagent-protocol.ts";

type SessionMessage = AgentSession["messages"][number];

/** Codex 574a36f: truncate_rollout_to_last_n_fork_turns, then keep_forked_rollout_item.
 * Pi supplies effective branch context (including compaction), not raw rollout events.
 * Task messages count as turn boundaries before being removed from inherited context. */
export function selectForkHistory(history: readonly SessionMessage[], forkTurns = "all"): SessionMessage[] {
  const mode = parseForkTurns(forkTurns);
  if (mode === "none") return [];
  let selected = history;
  if (mode !== "all") {
    const boundaries = history.flatMap((message, index) => message.role === "user"
      || (message.role === "custom" && message.customType === "subagent"
        && ((isJsonObject(message.details) && message.details.kind === "task") || contentText(message.content).startsWith("Message Type: NEW_TASK\n"))) ? [index] : []);
    if (!boundaries.length) return [];
    selected = history.slice(boundaries.at(-Number(mode)) ?? boundaries[0]!);
  }
  return selected.flatMap((message): SessionMessage[] => {
    // Host instructions are rebuilt for the child, not copied from the parent.
    // Pi's opaque context summaries correspond to Codex's retained compaction context.
    if (message.role === "user" || message.role === "compactionSummary" || message.role === "branchSummary") return [structuredClone(message)];
    if (message.role !== "assistant") return [];
    const phased = message.content.some((part) => part.type === "text" && assistantTextPhase(part.textSignature) !== undefined);
    // Codex labels final answers explicitly. Other Pi providers express the same
    // distinction through terminal stop reasons and absence of tool calls.
    if (!phased && !isFinalAssistantMessage(message.content, message.stopReason)) return [];
    const content = message.content.filter((part) => part.type === "text" && (!phased || assistantTextPhase(part.textSignature) === "final_answer"));
    return content.length ? [structuredClone({ ...message, content })] : [];
  });
}
