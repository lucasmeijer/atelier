import { escapeHtml, turboStream } from "./index.ts";

/** A region owns its markup; nested independently-owned islands use data-turbo-permanent. */
export interface LiveRegion {
  target: string;
  html: string;
  action?: "update" | "replace";
  /** Append-only HTML prefix. Resetting the prefix sends an authoritative replacement. */
  appendOnly?: boolean;
  children?: readonly LiveRegion[];
}

export interface LiveSubscription {
  unsubscribe(): void;
}

function regionStreams(regions: readonly LiveRegion[], previous: Map<string, string>, snapshot: boolean): string {
  let html = "";
  for (const region of regions) {
    const before = previous.get(region.target);
    const changed = snapshot || before !== region.html;
    if (changed) {
      const append = !snapshot && region.appendOnly && before !== undefined && region.html.startsWith(before);
      html += turboStream(append ? "append" : region.action ?? "update", region.target, append ? region.html.slice(before.length) : region.html, append ? {} : { method: "morph" });
      previous.set(region.target, region.html);
    }
    if (region.children) html += regionStreams(region.children, previous, changed);
  }
  return html;
}

/** One synchronous read/render/send path for initial state, changes and reconnects.
 * Invalidation coalesces; no snapshots, promises or event history are queued. */
export function createLivePresentation(render: () => readonly LiveRegion[], intervalMs = 0) {
  const listeners = new Set<(html: string) => void>();
  const previous = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function flush(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (disposed || listeners.size === 0) return;
    const regions = render();
    const html = regionStreams(regions, previous, false);
    const targets = new Set<string>();
    const visit = (items: readonly LiveRegion[]): void => {
      for (const item of items) { targets.add(item.target); if (item.children) visit(item.children); }
    };
    visit(regions);
    for (const target of previous.keys()) if (!targets.has(target)) previous.delete(target);
    if (html) for (const listener of listeners) listener(html);
  }

  return {
    invalidate(): void {
      if (!disposed && listeners.size && timer === undefined) timer = setTimeout(flush, intervalMs);
    },
    flush,
    subscribe(listener: (html: string) => void): LiveSubscription {
      if (disposed) throw new Error("Live presentation is disposed");
      // Bring existing clients to the same published state before the new mount joins.
      flush();
      const regions = render();
      const html = regionStreams(regions, previous, true);
      listeners.add(listener);
      try { listener(html); } catch (error) { listeners.delete(listener); throw error; }
      return { unsubscribe() {
        listeners.delete(listener);
        if (listeners.size === 0) {
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          previous.clear();
        }
      } };
    },
    dispose(): void {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      listeners.clear();
      previous.clear();
    },
  };
}

/** A keyed collection is represented by stable islands and independently rendered rows.
 * One generic morph reorders/removes islands; row updates never remount unchanged rows. */
export function liveCollection(target: string, rows: readonly { id: string; html: string; children?: readonly LiveRegion[] }[]): LiveRegion {
  return {
    target,
    html: rows.map(({ id }) => `<div id="${escapeHtml(id)}" data-turbo-permanent></div>`).join(""),
    children: rows.map(({ id, html, children }) => ({ target: id, html, children })),
  };
}

/** Asynchronous enrichment ends here, before publication. Invalidations during a
 * load discard its result. All waiters join the latest refresh, never an old one. */
export function createPublishedRefresh<T>(load: () => Promise<T>, publish: (value: T) => void) {
  let generation = 0;
  let pending: Promise<void> | undefined;
  let disposed = false;
  return {
    invalidate(): void { generation++; },
    refresh(): Promise<void> {
      if (disposed) throw new Error("Published refresh is disposed");
      generation++;
      if (pending) return pending;
      const completion = Promise.withResolvers<void>();
      pending = completion.promise;
      void (async () => {
        try {
          for (;;) {
            const started = generation;
            const value = await load();
            if (disposed) return;
            if (started !== generation) continue;
            publish(value);
            if (started === generation) return;
          }
        } finally {
          // Release ownership in the worker's final synchronous step, not in a
          // later promise reaction that could swallow a new refresh request.
          pending = undefined;
        }
      })().then(completion.resolve, completion.reject);
      return completion.promise;
    },
    dispose(): void { disposed = true; generation++; },
  };
}
