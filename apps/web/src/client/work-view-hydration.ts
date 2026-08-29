type WorkViewFrame = HTMLElement & {
  readonly complete: boolean;
  loading: "eager" | "lazy";
  loaded: Promise<void>;
  reload(): Promise<void>;
};

const attemptedFrames = new WeakSet<WorkViewFrame>();
const hydratedFrames = new WeakSet<WorkViewFrame>();
const invalidatedFrames = new WeakSet<WorkViewFrame>();
const pendingHydrations = new WeakMap<WorkViewFrame, Promise<void>>();

async function loadInitially(frame: WorkViewFrame): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (frame.hasAttribute("complete")) return;
  if (frame.complete) frame.loading = "eager";
  await frame.loaded;
}

export function hydrateWorkViewFrame(element: HTMLElement, options: { authoritativeReload?: boolean } = {}): Promise<void> {
  // SAFETY: Atelier renders every hydration target as a Turbo Frame.
  const frame = element as WorkViewFrame;
  if (options.authoritativeReload) invalidatedFrames.add(frame);
  const pending = pendingHydrations.get(frame);
  if (pending) {
    return invalidatedFrames.has(frame)
      ? pending.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0))).then(() => hydrateWorkViewFrame(frame))
      : pending;
  }

  const authoritativeReload = invalidatedFrames.delete(frame);
  const hydrated = hydratedFrames.has(frame) || frame.hasAttribute("complete");
  if (hydrated && !authoritativeReload) return Promise.resolve();
  const retry = attemptedFrames.has(frame) || hydrated;
  attemptedFrames.add(frame);
  hydratedFrames.delete(frame);
  if (hydrated && frame.loading === "lazy") frame.loading = "eager";
  const hydration = (retry ? frame.reload() : loadInitially(frame))
    .then(() => { hydratedFrames.add(frame); })
    .catch((error) => {
      if (authoritativeReload) invalidatedFrames.add(frame);
      throw error;
    })
    .finally(() => { pendingHydrations.delete(frame); });
  pendingHydrations.set(frame, hydration);
  return hydration;
}
