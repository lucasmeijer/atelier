import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Anthropic's default prompt-cache TTL, used only to explain likely idle expiry. */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Smaller differences are cache-breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024;
const NOTICE_TOKENS = 20_000;
const NOTICE_COST = 0.1;

export interface CacheMiss {
  missedTokens: number;
  missedCost: number;
  idleMs: number;
  modelChanged: boolean;
}

export interface ModelPriceSource {
  getModel(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

interface PreviousRequest {
  promptTokens: number;
  modelKey: string;
  timestamp: number;
  reportedCache: boolean;
}

interface SessionEntry {
  type: string;
  message?: AssistantMessage;
}

function detectMiss(prev: PreviousRequest | undefined, message: AssistantMessage, models: ModelPriceSource): CacheMiss | undefined {
  const usage = message.usage;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) return undefined;

  const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

  const paidTokens = usage.input + usage.cacheWrite;
  const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
  const readPerToken = usage.cacheRead > 0
    ? usage.cost.cacheRead / usage.cacheRead
    : (models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;

  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs: Math.max(0, message.timestamp - prev.timestamp),
    modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
  };
}

function asPreviousRequest(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
  const usage = message.usage;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (promptTokens <= 0) return undefined;
  return {
    promptTokens,
    modelKey: `${message.provider}/${message.model}`,
    timestamp: message.timestamp,
    reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
  };
}

interface CacheMissScan {
  prev: PreviousRequest | undefined;
  misses: Map<AssistantMessage, CacheMiss>;
}

function scan(entries: SessionEntry[], models: ModelPriceSource): CacheMissScan {
  let prev: PreviousRequest | undefined;
  const misses = new Map<AssistantMessage, CacheMiss>();

  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      prev = undefined;
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const miss = detectMiss(prev, entry.message, models);
    if (miss) misses.set(entry.message, miss);
    prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
  }
  return { prev, misses };
}

export function collectCacheMisses(entries: SessionEntry[], models: ModelPriceSource): Map<AssistantMessage, CacheMiss> {
  return scan(entries, models).misses;
}

/** The completed message must not be present in entries yet. */
export function detectCacheMiss(entries: SessionEntry[], message: AssistantMessage, models: ModelPriceSource): CacheMiss | undefined {
  return detectMiss(scan(entries, models).prev, message, models);
}

export function significantCacheMissNotice(miss: CacheMiss | undefined): string | undefined {
  if (!miss || (miss.missedTokens < NOTICE_TOKENS && miss.missedCost < NOTICE_COST)) return undefined;

  const tokens = miss.missedTokens >= 1_000_000
    ? `${(miss.missedTokens / 1_000_000).toFixed(1).replace(".0", "")}M`
    : `${(miss.missedTokens / 1000).toFixed(1).replace(".0", "")}k`;
  const cost = miss.missedCost >= 0.01 ? ` · ~$${miss.missedCost.toFixed(2)}` : "";
  let label = "Cache miss";
  if (miss.modelChanged) label = "Cache miss after model switch";
  else if (miss.idleMs >= CACHE_TTL_MS) label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
  return `⚠ ${label} · ${tokens} tokens re-billed${cost}`;
}
