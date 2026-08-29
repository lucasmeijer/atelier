type WorkViewFrame = HTMLElement & {
  loading: "eager" | "lazy";
  loaded: Promise<void>;
  reload(): Promise<void>;
};

const attemptedFrames = new WeakSet<WorkViewFrame>();
const hydratedFrames = new WeakSet<WorkViewFrame>();
const pendingHydrations = new WeakMap<WorkViewFrame, Promise<void>>();

export function hydrateWorkViewFrame(element: HTMLElement): Promise<void> {
  // SAFETY: Atelier renders every hydration target as a Turbo Frame.
  const frame = element as WorkViewFrame;
  if (hydratedFrames.has(frame)) return Promise.resolve();
  const pending = pendingHydrations.get(frame);
  if (pending) return pending;

  const retry = attemptedFrames.has(frame);
  attemptedFrames.add(frame);
  if (!retry) frame.loading = "eager";
  const hydration = (retry ? frame.reload() : frame.loaded)
    .then(() => { hydratedFrames.add(frame); })
    .finally(() => { pendingHydrations.delete(frame); });
  pendingHydrations.set(frame, hydration);
  return hydration;
}

export async function hydrateWorkViewFrames(root: ParentNode): Promise<void> {
  const frames = root.querySelectorAll<WorkViewFrame>("turbo-frame[data-work-view-hydration][src]");
  await Promise.all([...frames].map(hydrateWorkViewFrame));
}
