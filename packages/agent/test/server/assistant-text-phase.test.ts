import { expect, test } from "bun:test";
import { isFinalAssistantTextEvent } from "../../src/server/assistant-text-phase.ts";

test("final-answer phase collapses Working at text start while commentary stays inside it", () => {
  const textEvent = (phase: "commentary" | "final_answer", stopReason = "pending") => ({
    type: "text_start" as const,
    contentIndex: 0,
    partial: {
      stopReason,
      content: [{ type: "text", text: "", textSignature: JSON.stringify({ v: 1, id: "message-1", phase }) }],
    },
  });

  expect(isFinalAssistantTextEvent(textEvent("final_answer"))).toBe(true);
  expect(isFinalAssistantTextEvent(textEvent("commentary", "stop"))).toBe(false);
  expect(isFinalAssistantTextEvent({ type: "text_delta", contentIndex: 0, delta: "Done", partial: { stopReason: "stop", content: [{ type: "text", text: "Done" }] } })).toBe(true);
});
