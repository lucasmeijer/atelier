import type { ObservableTerminalTheme, ObservableTerminalViewer } from "@atelier/observable-terminal/client";

type TerminalViewerState =
  | { promise: Promise<ObservableTerminalViewer | undefined> }
  | { viewer: ObservableTerminalViewer };

export class TerminalViewerRegistry {
  private readonly states = new Map<string, TerminalViewerState>();

  active(key: string): ObservableTerminalViewer | undefined {
    const state = this.states.get(key);
    return state && "viewer" in state ? state.viewer : undefined;
  }

  setTheme(theme: ObservableTerminalTheme): void {
    for (const state of this.states.values()) {
      if ("viewer" in state) state.viewer.setTheme(theme);
    }
  }

  start(key: string, create: () => Promise<ObservableTerminalViewer>): Promise<ObservableTerminalViewer | undefined> {
    const existing = this.states.get(key);
    if (existing) return "viewer" in existing ? Promise.resolve(existing.viewer) : existing.promise;

    let state: TerminalViewerState;
    const promise = create().then((viewer) => {
      if (this.states.get(key) !== state) {
        viewer.dispose();
        return undefined;
      }
      this.states.set(key, { viewer });
      return viewer;
    }).catch((error: Error) => {
      if (this.states.get(key) === state) this.states.delete(key);
      throw error;
    });
    state = { promise };
    this.states.set(key, state);
    return promise;
  }

  cancel(key: string): void {
    const state = this.states.get(key);
    this.states.delete(key);
    if (state && "viewer" in state) state.viewer.dispose();
  }
}
