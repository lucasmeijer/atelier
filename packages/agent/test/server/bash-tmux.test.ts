import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const execWorkspaceShell = mock(async (_workspaceId: string, command: string) => {
  if (command.includes("new-session")) return { stdout: "", stderr: "", exitCode: 0 };
  if (command.includes("cat '/tmp/atelier-agent-") && command.includes(".exit")) return { stdout: "0\n", stderr: "", exitCode: 0 };
  if (command.includes("capture-pane")) return { stdout: "", stderr: "", exitCode: 0 };
  if (command.includes("kill-session")) return { stdout: "", stderr: "", exitCode: 0 };
  return { stdout: "", stderr: "", exitCode: 0 };
});

const execWorkspaceCommand = mock(async (_workspaceId: string, _args: string[]) => ({ stdout: "", stderr: "", exitCode: 0 }));

mock.module("@atelier/workspace", () => ({
  execWorkspaceShell,
  execWorkspaceCommand,
  workspaceContainerName: (workspaceId: string) => `atelier-${workspaceId}`,
  workspaceRoot: "/work",
}));

const { agentTermCols, agentTermRows, createTmuxBashTool, stripTmuxPaneFraming } = await import("../../src/server/bash-tmux.ts");

function textResult(result: any): string {
  return result.content.map((part: { text?: string }) => part.text ?? "").join("");
}

async function executeBash(params: { command: string; timeout?: number }) {
  return await createTmuxBashTool("ws").execute("call", params, undefined, undefined, {} as any);
}

describe("tmux bash tool", () => {
  beforeEach(() => {
    execWorkspaceShell.mockClear();
    execWorkspaceCommand.mockClear();
  });

  afterEach(() => {
    execWorkspaceShell.mockImplementation(async (_workspaceId: string, command: string) => {
      if (command.includes("new-session")) return { stdout: "", stderr: "", exitCode: 0 };
      if (command.includes("cat '/tmp/atelier-agent-") && command.includes(".exit")) return { stdout: "0\n", stderr: "", exitCode: 0 };
      if (command.includes("capture-pane")) return { stdout: "", stderr: "", exitCode: 0 };
      if (command.includes("kill-session")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    execWorkspaceCommand.mockImplementation(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
  });

  test("forces a stable tty size for carriage-return progress UIs", async () => {
    await executeBash({ command: "git clone https://example.com/repo.git" });

    const createCall = execWorkspaceShell.mock.calls.find(([, command]) => command.includes("new-session"));
    expect(createCall).toBeDefined();
    const command = createCall![1];
    expect(command).toContain(`-x ${agentTermCols} -y ${agentTermRows}`);
    expect(command).toContain(`stty cols ${agentTermCols} rows ${agentTermRows}`);
    expect(command).toContain(`COLUMNS=${agentTermCols} LINES=${agentTermRows}`);
  });

  test("returns ANSI-stripped model output while storing colored pane output", async () => {
    execWorkspaceCommand.mockImplementation(async () => ({
      stdout: "Script started on 2026-06-13\n\u001b[31mred\u001b[0m\r\nScript done on 2026-06-13\n",
      stderr: "",
      exitCode: 0,
    }));
    execWorkspaceShell.mockImplementation(async (_workspaceId: string, command: string) => {
      if (command.includes("capture-pane")) return { stdout: "\u001b[31mred\u001b[0m\nPane is dead\n", stderr: "", exitCode: 0 };
      if (command.includes("cat '/tmp/atelier-agent-") && command.includes(".exit")) return { stdout: "0\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = await executeBash({ command: "printf red" });

    expect(textResult(result)).toBe("red");
    expect(result.details.displayAnsi).toBe("\u001b[31mred\u001b[0m");
    expect(result.details.displayAnsi).not.toContain("Pane is dea");
    expect(result.details.exitCode).toBe(0);
  });

  test("reports terminal display volume when rich terminal controls erase the model transcript", async () => {
    const paneText = [
      "Restore succeeded with 3 warning(s) in 1.1s",
      "  LanguageModels succeeded (0.4s) → LanguageModels/bin/Debug/net9.0/LanguageModels.dll",
      "  ProfessionalReportServer succeeded (0.6s) → ProfessionalReportServer/bin/Debug/net9.0/ProfessionalReportServer.dll",
      "",
      "Build succeeded with 6 warning(s) in 3.1s",
    ].join("\n");
    const raw = `\u001b[?25lRestore running\r\u001b[2KBuild running\r\u001b=`;
    execWorkspaceCommand.mockImplementation(async () => ({
      stdout: raw,
      stderr: "",
      exitCode: 0,
    }));
    execWorkspaceShell.mockImplementation(async (_workspaceId: string, command: string) => {
      if (command.includes("capture-pane")) return { stdout: `\u001b[32m${paneText}\u001b[0m\nPane is dead\n`, stderr: "", exitCode: 0 };
      if (command.includes("cat '/tmp/atelier-agent-") && command.includes(".exit")) return { stdout: "0\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = await executeBash({ command: "dotnet build ProfessionalReport.sln -v:minimal" });

    expect(textResult(result)).toBe(`(model transcript empty after stripping terminal controls)\n\nTerminal display captured 5 lines (${Buffer.byteLength(paneText, "utf8")} bytes) of rendered output; raw PTY log was ${Buffer.byteLength(raw, "utf8")} bytes.`);
    expect(result.details).toMatchObject({ terminalDisplayLines: 5, terminalDisplayBytes: Buffer.byteLength(paneText, "utf8"), rawPtyLogBytes: Buffer.byteLength(raw, "utf8") });
    expect(result.details.displayAnsi).toContain("\u001b[32mRestore succeeded");
    expect(result.details.displayAnsi).not.toContain("Pane is dea");
  });

  test("removes full and partial tmux dead-pane markers from captured display output", () => {
    expect(stripTmuxPaneFraming("ok\nPane is dead\n")).toBe("ok");
    expect(stripTmuxPaneFraming("ok\n\u001b[2mPane is dead\u001b[0m\r\n")).toBe("ok");
    expect(stripTmuxPaneFraming("ok\nPane is dea")).toBe("ok");
  });

  test("collapses carriage-return progress in display fallback output", async () => {
    const raw = "Cloning into 'repo'...\r\nremote: Counting objects:   1% (1/94)\rremote: Counting objects:   2% (2/94)\rremote: Counting objects: 100% (94/94)\r\n";
    execWorkspaceCommand.mockImplementation(async () => ({ stdout: raw, stderr: "", exitCode: 0 }));
    execWorkspaceShell.mockImplementation(async (_workspaceId: string, command: string) => {
      if (command.includes("capture-pane")) return { stdout: "", stderr: "", exitCode: 0 };
      if (command.includes("cat '/tmp/atelier-agent-") && command.includes(".exit")) return { stdout: "0\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = await executeBash({ command: "git clone https://example.com/repo.git" });

    expect(result.details.displayAnsi).toBe("Cloning into 'repo'...\nremote: Counting objects: 100% (94/94)");
    expect(result.details.displayAnsi).not.toContain("1% (1/94)remote:");
  });

  test("captures 100 lines from the model log and tmux scrollback display", async () => {
    const plainLines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
    const ansiLines = plainLines.map((line) => `\u001b[32m${line}\u001b[0m`);
    execWorkspaceCommand.mockImplementation(async () => ({ stdout: `${plainLines.join("\n")}\n`, stderr: "", exitCode: 0 }));
    execWorkspaceShell.mockImplementation(async (_workspaceId: string, command: string) => {
      if (command.includes("capture-pane")) return { stdout: `${ansiLines.join("\n")}\nPane is dead\n`, stderr: "", exitCode: 0 };
      if (command.includes("cat '/tmp/atelier-agent-") && command.includes(".exit")) return { stdout: "0\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = await executeBash({ command: "seq 1 100" });

    expect(textResult(result)).toBe(plainLines.join("\n"));
    expect(result.details.displayAnsi.split("\n")).toHaveLength(100);
    expect(result.details.displayAnsi).toStartWith("\u001b[32mline 1\u001b[0m");
    expect(result.details.displayAnsi).toEndWith("\u001b[32mline 100\u001b[0m");
    expect(result.details.displayAnsi).not.toContain("Pane is dea");
    expect(execWorkspaceShell.mock.calls.some(([, command]) => command.includes("capture-pane") && command.includes("-S -100000"))).toBe(true);
  });

  test("reports non-zero exit codes to the model result without adding them to displayAnsi", async () => {
    execWorkspaceCommand.mockImplementation(async () => ({ stdout: "failure\n", stderr: "", exitCode: 0 }));
    execWorkspaceShell.mockImplementation(async (_workspaceId: string, command: string) => {
      if (command.includes("capture-pane")) return { stdout: "\u001b[31mfailure\u001b[0m\nPane is dea", stderr: "", exitCode: 0 };
      if (command.includes("cat '/tmp/atelier-agent-") && command.includes(".exit")) return { stdout: "7\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = await executeBash({ command: "false" });

    expect(textResult(result)).toBe("failure\n\nCommand exited with code 7");
    expect(result.details).toMatchObject({ exitCode: 7, aborted: false, timedOut: false });
    expect(result.details.displayAnsi).toBe("\u001b[31mfailure\u001b[0m");
  });
});
