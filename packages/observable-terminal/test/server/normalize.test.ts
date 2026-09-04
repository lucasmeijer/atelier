import { describe, expect, test } from "bun:test";
import {
  buildAttachArgs,
  buildListSessionsCommand,
  buildNaturalScrollCommand,
  buildObservableSessionCommand,
  normalizeCarriageReturns,
  observableTerminalCols,
  observableTerminalRows,
  stripObservablePaneFraming,
  stripTerminalControls,
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

  test("strips terminal control sequences without leaking their final bytes", () => {
    expect(stripTerminalControls("\u001b[?1h\u001b=ok\u001b>")).toBe("ok");
    expect(stripTerminalControls("a\u001b[2Kb\u001b[39;49mc")).toBe("abc");
    expect(stripTerminalControls("a\u001b]8;;file:///tmp/x\u001b\\b\u001b]8;;\u001b\\c")).toBe("abc");
    expect(stripTerminalControls("a\u001bPignored\u001b\\b")).toBe("ab");
  });

  test("quotes custom tmux session list formats", () => {
    expect(buildListSessionsCommand("#{session_name} | #{pane_current_path}")).toBe("tmux list-sessions -F '#{session_name} | #{pane_current_path}'");
  });

  test("configures natural scrolling through tmux history", () => {
    const command = buildNaturalScrollCommand();
    expect(command).toContain("set-option -g mouse on");
    expect(command).toContain("S-PPage copy-mode -e");
    expect(command).toContain("S-PPage send-keys -X page-up");
    expect(command).toContain("S-NPage send-keys -X page-down");
  });

  test("builds fixed-size observable sessions", () => {
    const command = buildObservableSessionCommand({ session: "s", cwd: "/work", command: "/bin/bash", fixedSize: true });
    expect(command).not.toContain("set-option -g");
    expect(command).toContain(`-x ${observableTerminalCols} -y ${observableTerminalRows}`);
    expect(command).toContain("window-size manual");
    expect(command).toContain(`resize-window -t 's' -x ${observableTerminalCols} -y ${observableTerminalRows}`);
    expect(command).toContain("status off");
  });

  test("hides tmux dead-pane footer when panes remain on exit", () => {
    const command = buildObservableSessionCommand({ session: "s", cwd: "/work", command: "/bin/bash", remainOnExit: true });
    expect(command).toContain("remain-on-exit on");
    expect(command).toContain("remain-on-exit-format ''");
  });

  test("builds readonly fixed-size attach arguments", () => {
    const args = buildAttachArgs({ containerName: "atelier-ws", session: "s", cols: 120, rows: 30, readonly: true, fixedSize: true });
    expect(args).toContain("resize-window");
    expect(args).toContain("attach-session");
    expect(args).toContain("-r");
  });
});
