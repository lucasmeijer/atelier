import { describe, expect, mock, test } from "bun:test";
import type { ObservableTerminalViewer } from "@atelier/observable-terminal/client";
import { TerminalViewerRegistry } from "../../src/client/terminal-viewer-registry.ts";

function viewer(): ObservableTerminalViewer {
  return {
    dispose: mock(() => undefined),
    focus: mock(() => undefined),
    refresh: mock(() => undefined),
    sendInput: mock(() => undefined),
    getSelection: mock(async () => ""),
    dragPointer: mock(() => undefined),
    paste: mock(() => undefined),
    setTheme: mock(() => undefined),
  };
}

describe("terminal viewer registry", () => {
  test("shares an in-flight initialization", async () => {
    const terminals = new TerminalViewerRegistry();
    const pending = Promise.withResolvers<ObservableTerminalViewer>();
    const create = mock(() => pending.promise);
    const started = terminals.start("terminal", create);

    expect(terminals.start("terminal", create)).toBe(started);
    expect(create).toHaveBeenCalledTimes(1);
    const active = viewer();
    pending.resolve(active);
    expect(await started).toBe(active);
    expect(terminals.active("terminal")).toBe(active);
  });

  test("disposes a cancelled initialization without replacing its restart", async () => {
    const terminals = new TerminalViewerRegistry();
    const pending = Promise.withResolvers<ObservableTerminalViewer>();
    const stale = terminals.start("terminal", () => pending.promise);
    terminals.cancel("terminal");
    const currentViewer = viewer();
    await terminals.start("terminal", async () => currentViewer);

    const staleViewer = viewer();
    pending.resolve(staleViewer);

    expect(await stale).toBeUndefined();
    expect(staleViewer.dispose).toHaveBeenCalledTimes(1);
    expect(terminals.active("terminal")).toBe(currentViewer);
  });

  test("cancels and disposes an active terminal", async () => {
    const terminals = new TerminalViewerRegistry();
    const active = viewer();
    await terminals.start("terminal", async () => active);

    terminals.cancel("terminal");

    expect(active.dispose).toHaveBeenCalledTimes(1);
    expect(terminals.active("terminal")).toBeUndefined();
  });
});
