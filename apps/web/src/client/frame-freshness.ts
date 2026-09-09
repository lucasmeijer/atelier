type HydratableFrame = HTMLElement & {
  readonly complete: boolean;
  loading: "eager" | "lazy";
  loaded: Promise<void>;
  reload(): Promise<void>;
};

/** Freshness belongs to the frame element, not its current presentation or resident. */
class FrameFreshness {
  private generation = 0;
  private loadedGeneration = -1;
  private attempted = false;
  private pending?: Promise<void>;
  private renderSequence = 0;
  private lastRenderSucceeded = false;

  constructor(private readonly frame: HydratableFrame) {}

  invalidate(): void {
    this.generation += 1;
  }

  /** Delivered by the frame's Stimulus turbo:frame-render action, not frame-load. */
  rendered(succeeded: boolean): void {
    this.renderSequence += 1;
    this.lastRenderSucceeded = succeeded;
  }

  get isFresh(): boolean {
    if (this.pending || !this.lastRenderSucceeded) return false;
    return this.loadedGeneration === this.generation
      || (!this.attempted && this.generation === 0);
  }

  /** All callers join one load, including any invalidations received during it. */
  ensureFresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.isFresh) return Promise.resolve();
    const pending = this.loadLatest().finally(() => { this.pending = undefined; });
    this.pending = pending;
    return pending;
  }

  private async loadLatest(): Promise<void> {
    do {
      const renderSequence = this.renderSequence;
      const reload = this.attempted || this.frame.hasAttribute("complete");
      // An initial request may have started before we observed an invalidation.
      // Only a reload we initiate can satisfy a nonzero generation.
      const generation = reload ? this.generation : 0;
      this.attempted = true;
      if (reload) {
        if (this.frame.hasAttribute("complete") && this.frame.loading === "lazy") this.frame.loading = "eager";
        await this.frame.reload();
      } else {
        // Let Turbo connect and publish its initial request before reading loaded.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        if (!this.frame.hasAttribute("complete")) {
          if (this.frame.complete) this.frame.loading = "eager";
          await this.frame.loaded;
        }
      }
      // Turbo also settles loaded on network errors, non-HTML responses, and
      // missing frames (which even set complete). Only a successful render counts.
      if (this.renderSequence === renderSequence || !this.lastRenderSucceeded) {
        throw new Error(`Could not load workspace surface ${this.frame.id}: no successful frame render`);
      }
      this.loadedGeneration = generation;
    } while (this.loadedGeneration !== this.generation);
  }
}

const frames = new WeakMap<HTMLElement, FrameFreshness>();

/** Only pass Atelier-rendered Turbo Frames with a src. Replaced frames start fresh. */
export function frameFreshness(element: HTMLElement): FrameFreshness {
  let freshness = frames.get(element);
  if (!freshness) {
    // SAFETY: Callers select server-rendered Turbo Frame hydration targets.
    freshness = new FrameFreshness(element as HydratableFrame);
    frames.set(element, freshness);
  }
  return freshness;
}
