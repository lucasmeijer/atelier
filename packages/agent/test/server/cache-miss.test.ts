import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { collectCacheMisses, detectCacheMiss, significantCacheMissNotice } from "../../src/server/cache-miss.ts";

const models = { getModel: () => ({ cost: { cacheRead: 0.3 } }) };

function assistant(options: { cacheRead?: number; cacheWrite?: number; model?: string; timestamp?: number; cacheWriteCost?: number }): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: options.model ?? "claude",
    usage: {
      input: 0,
      output: 10,
      cacheRead: options.cacheRead ?? 0,
      cacheWrite: options.cacheWrite ?? 0,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: (options.cacheRead ?? 0) * 0.3 / 1_000_000, cacheWrite: options.cacheWriteCost ?? 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: options.timestamp ?? 0,
  } as AssistantMessage;
}

const entry = (message: AssistantMessage) => ({ type: "message", message });

const first = assistant({ cacheWrite: 100_000, cacheWriteCost: 0.375 });
const healthy = assistant({ cacheRead: 100_000, cacheWrite: 5_000, cacheWriteCost: 0.01875, timestamp: 60_000 });
const missed = assistant({ cacheWrite: 110_000, cacheWriteCost: 0.4125, timestamp: 600_000 });

describe("cache miss notices", () => {
  test("reports significant re-billed tokens and incremental cost", () => {
    const miss = detectCacheMiss([entry(first), entry(healthy)], missed, models);
    expect(miss?.missedTokens).toBe(105_000);
    expect(miss?.missedCost).toBeCloseTo(0.36225, 5);
    expect(significantCacheMissNotice(miss)).toBe("⚠ Cache miss after 9m idle · 105k tokens re-billed · ~$0.36");
  });

  test("re-derives historical notices but resets after compaction", () => {
    expect(collectCacheMisses([entry(first), entry(healthy), entry(missed)], models).get(missed)?.missedTokens).toBe(105_000);
    expect(collectCacheMisses([entry(first), { type: "compaction" }, entry(missed)], models).size).toBe(0);
  });

  test("suppresses cache-breakpoint noise and small notices", () => {
    const small = assistant({ cacheRead: 99_000, cacheWrite: 2_000, cacheWriteCost: 0.0075, timestamp: 120_000 });
    expect(detectCacheMiss([entry(first)], small, models)).toBeUndefined();
    expect(significantCacheMissNotice({ missedTokens: 10_000, missedCost: 0.05, idleMs: 0, modelChanged: false })).toBeUndefined();
  });
});
