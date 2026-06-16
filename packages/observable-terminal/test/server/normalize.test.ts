import { describe, expect, test } from "bun:test";
import {
  buildAttachArgs,
  buildObservableSessionCommand,
  normalizeCarriageReturns,
  observableTerminalCols,
  observableTerminalRows,
  stripObservablePaneFraming,
} from "../../src/server/index.ts";

describe("observable terminal normalization", () => {
  test("collapses carriage-return progress repaints", () => {
    const raw = "Cloning into 'repo'...\r\nremote: Counting objects:   1% (1/94)\rremote: Counting objects:   2% (2/94)\rremote: Counting objects: 100% (94/94)\r\n";
    const normalized = normalizeCarriageReturns(raw);
    expect(normalized).toBe("Cloning into 'repo'...\nremote: Counting objects: 100% (94/94)\n");
    expect(normalized).not.toContain("1% (1/94)remote:");
  });

  test("removes full and partial dead-pane markers", () => {
    expect(stripObservablePaneFraming("ok\nPane is dead\n")).toBe("ok");
    expect(stripObservablePaneFraming("ok\n\u001b[2mPane is dead\u001b[0m\r\n")).toBe("ok");
    expect(stripObservablePaneFraming("ok\nPane is dea")).toBe("ok");
  });

  test("builds fixed-size observable sessions", () => {
    const command = buildObservableSessionCommand({ session: "s", cwd: "/work", command: "/bin/bash", fixedSize: true });
    expect(command).toContain(`-x ${observableTerminalCols} -y ${observableTerminalRows}`);
    expect(command).toContain("window-size manual");
    expect(command).toContain("status off");
  });

  test("builds readonly fixed-size attach arguments", () => {
    const args = buildAttachArgs({ containerName: "atelier-ws", session: "s", cols: 120, rows: 30, readonly: true, fixedSize: true });
    expect(args).toContain("resize-window");
    expect(args).toContain("attach-session");
    expect(args).toContain("-r");
  });
});
