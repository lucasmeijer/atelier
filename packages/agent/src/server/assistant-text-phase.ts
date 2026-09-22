import { assistantTextPhase } from "./transcript.ts";

interface AssistantTextEventView {
  type: "text_start" | "text_delta";
  contentIndex: number;
  delta?: string;
  partial: {
    stopReason?: string;
    content?: Array<{ type: string; text?: string; textSignature?: string }>;
  };
}

/** True at the earliest Pi event that identifies streamed text as the final answer. */
export function isFinalAssistantTextEvent(event: AssistantTextEventView): boolean {
  const partial = event.partial;
  const part = partial.content?.[event.contentIndex];
  if (part?.type !== "text") return false;
  const phase = assistantTextPhase(part.textSignature);
  if (phase !== undefined) return phase === "final_answer";
  return partial.stopReason === "stop" || partial.stopReason === "length" || partial.stopReason === "deferred";
}
