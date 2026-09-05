import { Type, type Static } from "typebox";

export const turnTimingEntryType = "atelier.turn-timing";
export const turnTimingSchema = Type.Object({
  elapsedMs: Type.Number({ minimum: 0 }),
  toolMs: Type.Number({ minimum: 0 }),
  inferenceMs: Type.Number({ minimum: 0 }),
  outputTokens: Type.Number({ minimum: 0 }),
  usageComplete: Type.Boolean(),
});
export type TurnTimingSummary = Static<typeof turnTimingSchema>;

/** Measures wait intervals, not summed tool durations or visible text length. */
export class TurnTiming {
  private readonly tools = new Set<string>();
  private toolStartedAt = 0;
  private toolMs = 0;
  private inferenceStartedAt?: number;
  private inferenceMs = 0;
  private outputTokens = 0;
  private usageComplete = true;

  constructor(private readonly startedAt: number) {}

  inferenceStart(now: number): void {
    this.inferenceStartedAt = now;
  }

  inferenceEnd(now: number, outputTokens: number | undefined): void {
    if (this.inferenceStartedAt !== undefined) {
      this.inferenceMs += now - this.inferenceStartedAt;
      this.inferenceStartedAt = undefined;
    }
    // Provider output includes reasoning tokens; do not add them a second time.
    if (outputTokens !== undefined && Number.isFinite(outputTokens) && outputTokens >= 0) this.outputTokens += outputTokens;
    else this.usageComplete = false;
  }

  toolStart(id: string, now: number): void {
    if (this.tools.size === 0) this.toolStartedAt = now;
    this.tools.add(id);
  }

  toolEnd(id: string, now: number): void {
    this.tools.delete(id);
    if (this.tools.size === 0) this.toolMs += now - this.toolStartedAt;
  }

  snapshot(now: number): TurnTimingSummary {
    return {
      elapsedMs: now - this.startedAt,
      toolMs: this.toolMs + (this.tools.size ? now - this.toolStartedAt : 0),
      inferenceMs: this.inferenceMs + (this.inferenceStartedAt === undefined ? 0 : now - this.inferenceStartedAt),
      outputTokens: this.outputTokens,
      usageComplete: this.usageComplete && this.inferenceStartedAt === undefined,
    };
  }
}
