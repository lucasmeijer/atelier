import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { agentSessionNeedsRestartRecovery, atelierRestartPrompt } from "../../src/server/restart-recovery.ts";

function entries(...values: unknown[]): SessionEntry[] {
  // SAFETY: Tests construct only the SessionEntry shapes needed by the recovery predicate.
  return values as SessionEntry[];
}

const message = (role: string, stopReason?: string) => ({
  type: "message",
  id: crypto.randomUUID(),
  parentId: null,
  timestamp: new Date().toISOString(),
  message: { role, content: [], stopReason },
});

describe("Agent restart recovery", () => {
  test("does not start a new turn for empty or completed sessions", () => {
    expect(agentSessionNeedsRestartRecovery([])).toBe(false);
    expect(agentSessionNeedsRestartRecovery(entries(message("assistant", "stop")))).toBe(false);
    expect(agentSessionNeedsRestartRecovery(entries(message("assistant", "length")))).toBe(false);
    expect(agentSessionNeedsRestartRecovery(entries(message("assistant", "deferred")))).toBe(false);
  });

  test("recovers sessions whose active branch ends during a turn", () => {
    expect(agentSessionNeedsRestartRecovery(entries(message("user")))).toBe(true);
    expect(agentSessionNeedsRestartRecovery(entries(message("assistant", "toolUse")))).toBe(true);
    expect(agentSessionNeedsRestartRecovery(entries(message("assistant", "aborted")))).toBe(true);
    expect(agentSessionNeedsRestartRecovery(entries(
      message("assistant", "toolUse"),
      message("toolResult"),
    ))).toBe(true);
  });

  test("uses the last message rather than trailing session metadata", () => {
    expect(agentSessionNeedsRestartRecovery(entries(
      message("assistant", "stop"),
      { type: "model_change", id: "model", parentId: null, provider: "openai", modelId: "gpt" },
    ))).toBe(false);
  });

  test("uses the host restart handoff message verbatim", () => {
    expect(atelierRestartPrompt).toBe("The atelier host had to restart. Your execution environment did not restart. You may continue if you had any unfinished business");
  });
});
