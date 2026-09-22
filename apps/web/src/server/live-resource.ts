import { createLivePresentation, createPublishedRefresh, type LiveRegion } from "@atelier/shared";

/** I/O publishes a committed value shared by HTTP rendering and Cable snapshots. */
export function createLiveResource<T>(load: () => Promise<T>, render: (state: T) => readonly LiveRegion[], onError: (error: Error) => void) {
  let state: T | undefined;
  let subscribers = 0;
  let disposed = false;
  const presentation = createLivePresentation(() => render(state!));
  const refresh = createPublishedRefresh(load, next => {
    state = next;
    presentation.invalidate();
  });
  async function read(): Promise<T> {
    for (;;) {
      if (disposed) throw new Error("Live resource is disposed");
      if (state !== undefined) return state;
      await refresh.refresh();
    }
  }
  return {
    read,
    async subscribe(listener: (html: string) => void) {
      subscribers++;
      try {
        await read();
        const subscription = presentation.subscribe(listener);
        let active = true;
        return { unsubscribe() {
          if (!active) return;
          active = false;
          subscription.unsubscribe();
          subscribers--;
        } };
      } catch (error) {
        subscribers--;
        throw error;
      }
    },
    invalidate() {
      if (!subscribers) { state = undefined; refresh.invalidate(); return; }
      void refresh.refresh().catch(error => onError(error instanceof Error ? error : new Error(String(error))));
    },
    dispose() {
      disposed = true;
      refresh.dispose();
      presentation.dispose();
      state = undefined;
    },
  };
}
