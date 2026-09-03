export const compactionKeepRecentTokens = 6000;

export function manualCompactionAvailable(contextTokens: number | null | undefined, latestEntryType: string | undefined): boolean {
  return latestEntryType !== "compaction" && contextTokens !== null && contextTokens !== undefined && contextTokens > compactionKeepRecentTokens;
}

export function terminalCompactionNotice(event: { errorMessage?: string; aborted?: boolean }): { level: "info" | "error"; message: string } | undefined {
  if (event.errorMessage) return { level: "error", message: event.errorMessage };
  if (event.aborted) return { level: "info", message: "Compaction cancelled" };
  return undefined;
}

export function contextUsagePercent(measured: number | null | undefined, estimatedTokens: number | undefined, contextWindow: number | undefined): number | null {
  return measured ?? (estimatedTokens !== undefined && contextWindow ? estimatedTokens / contextWindow * 100 : null);
}
