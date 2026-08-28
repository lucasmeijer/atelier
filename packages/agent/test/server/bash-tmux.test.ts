import { beforeEach, describe, expect, mock, test } from "bun:test";

import { agentTermCols, agentTermRows, createTmuxBashTool, stripTmuxPaneFraming } from "../../src/server/bash-tmux.ts";

const success = { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };

async function defaultExecWorkspaceShell(_workspaceId: string, command: string) {
  if (command.includes("cat '/tmp/atelier-agent-") && command.includes(".exit")) return { ...success, stdout: "0\n" };
  return success;
}

const execWorkspaceShell = mock(defaultExecWorkspaceShell);

function textResult(result: any): string {
  return result.content.map((part: { text?: string }) => part.text ?? "").join("");
}

async function executeBash(params: { command: string; timeout?: number }) {
  // SAFETY: This concrete callback declares only four parameters and cannot
  // inspect Pi's fifth ExtensionContext; the direct test supplies an ignored placeholder.
  return await createTmuxBashTool("ws", execWorkspaceShell).execute("call", params, undefined, undefined, undefined as never);
}

function mockPaneOutput(stdout: string, exitCode = 0): void {
  execWorkspaceShell.mockImplementation(async (_workspaceId: string, command: string) => {
    if (command.includes("capture-pane")) return { ...success, stdout };
    if (command.includes("cat '/tmp/atelier-agent-") && command.includes(".exit")) return { ...success, stdout: `${exitCode}\n` };
    return success;
  });
}

describe("tmux bash tool", () => {
  beforeEach(() => {
    execWorkspaceShell.mockClear();
    execWorkspaceShell.mockImplementation(defaultExecWorkspaceShell);
  });

  test("forces a stable tty size for carriage-return progress UIs", async () => {
    await executeBash({ command: "git clone https://example.com/repo.git" });

    const createCall = execWorkspaceShell.mock.calls.find(([, command]) => command.includes("new-session"));
    expect(createCall).toBeDefined();
    const command = createCall![1];
    expect(command).toContain(`-x ${agentTermCols} -y ${agentTermRows}`);
    expect(command).toContain(`stty cols ${agentTermCols} rows ${agentTermRows}`);
    expect(command).toContain(`COLUMNS='\\''${agentTermCols}'\\''`);
    expect(command).toContain(`LINES='\\''${agentTermRows}'\\''`);
    expect(command).not.toContain("script -qefc");
  });

  test("returns plain model output from rendered pane while storing colored pane output", async () => {
    mockPaneOutput("\u001b[31mred\u001b[0m\nPane is dead\n");

    const result = await executeBash({ command: "printf red" });

    expect(textResult(result)).toBe("red");
    expect(result.details.displayAnsi).toBe("\u001b[31mred\u001b[0m");
    expect(result.details.displayAnsi).not.toContain("Pane is dea");
    expect(result.details.exitCode).toBe(0);
  });

  test("uses tmux rendered pane output for dotnet-style terminal UI output", async () => {
    const paneText = [
      "Restore succeeded with 3 warning(s) in 1.1s",
      "  LanguageModels succeeded (0.4s) → LanguageModels/bin/Debug/net9.0/LanguageModels.dll",
      "  ProfessionalReportServer succeeded (0.6s) → ProfessionalReportServer/bin/Debug/net9.0/ProfessionalReportServer.dll",
      "",
      "Build succeeded with 6 warning(s) in 3.1s",
    ].join("\n");
    mockPaneOutput(`\u001b[32m${paneText}\u001b[0m\nPane is dead\n`);

    const result = await executeBash({ command: "dotnet build ProfessionalReport.sln -v:minimal" });

    expect(textResult(result)).toBe(paneText);
    expect(result.details.displayAnsi).toContain("\u001b[32mRestore succeeded");
    expect(result.details.displayAnsi).not.toContain("Pane is dea");
  });

  test("removes full and partial tmux dead-pane markers from captured display output", () => {
    expect(stripTmuxPaneFraming("ok\nPane is dead\n")).toBe("ok");
    expect(stripTmuxPaneFraming("ok\n\u001b[2mPane is dead\u001b[0m\r\n")).toBe("ok");
    expect(stripTmuxPaneFraming("ok\nPane is dea")).toBe("ok");
  });

  test("uses rendered tmux capture for carriage-return progress output", async () => {
    const rendered = "Cloning into 'repo'...\nremote: Counting objects: 100% (94/94)";
    mockPaneOutput(`${rendered}\nPane is dead\n`);

    const result = await executeBash({ command: "git clone https://example.com/repo.git" });

    expect(textResult(result)).toBe(rendered);
    expect(result.details.displayAnsi).toBe(rendered);
  });

  test("captures 100 lines from tmux scrollback for model and terminal display", async () => {
    const plainLines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
    const ansiLines = plainLines.map((line) => `\u001b[32m${line}\u001b[0m`);
    mockPaneOutput(`${ansiLines.join("\n")}\nPane is dead\n`);

    const result = await executeBash({ command: "seq 1 100" });

    expect(textResult(result)).toBe(plainLines.join("\n"));
    expect(result.details.displayAnsi.split("\n")).toHaveLength(100);
    expect(result.details.displayAnsi).toStartWith("\u001b[32mline 1\u001b[0m");
    expect(result.details.displayAnsi).toEndWith("\u001b[32mline 100\u001b[0m");
    expect(result.details.displayAnsi).not.toContain("Pane is dea");
    expect(result.details.fullOutputPath).toBeUndefined();
    expect(execWorkspaceShell.mock.calls.some(([, command]) => command.includes("capture-pane") && command.includes("-S -100000") && !command.includes(" -e"))).toBe(true);
    expect(execWorkspaceShell.mock.calls.some(([, command]) => command.includes("capture-pane") && command.includes("-S -100000") && command.includes(" -e"))).toBe(true);
    expect(execWorkspaceShell.mock.calls.some(([, command]) => command.includes("new-session") && command.includes("pipe-pane") && command.includes("umask 077") && command.includes("atelier-agent-") && command.includes(".log"))).toBe(true);
  });

  test("keeps the tail within Pi's 50 KiB and 2000-line model limits", async () => {
    const lines = Array.from({ length: 2100 }, (_, index) => String(index + 1).padStart(4, "0"));
    mockPaneOutput(`${lines.join("\n")}\nPane is dead\n`);

    const result = await executeBash({ command: "print-many-lines" });
    const output = textResult(result);

    expect(output).toStartWith(lines[100]);
    expect(output).not.toContain(lines[99]);
    expect(output).toContain(lines[2099]);
    expect(output).toContain("[Output truncated: showing the last");
    expect(output).toContain(`Full output: ${result.details.fullOutputPath}]`);
    expect(result.details.displayAnsi).toEndWith(output.slice(output.indexOf("[Output truncated:")));
    expect(result.details.fullOutputPath).toMatch(/^\/tmp\/atelier-agent-[a-f0-9]{8}\.log$/);
  });

  test("limits model-facing output to the last 50 KiB", async () => {
    const lines = Array.from({ length: 700 }, (_, index) => `${String(index + 1).padStart(4, "0")}:${"x".repeat(90)}`);
    mockPaneOutput(`${lines.join("\n")}\nPane is dead\n`);

    const result = await executeBash({ command: "print-many-wide-lines" });
    const output = textResult(result);

    expect(Buffer.byteLength(output)).toBeLessThan(52 * 1024);
    expect(output).not.toContain(lines[0]);
    expect(output).toContain(lines[699]);
    expect(output).toContain("[Output truncated: showing the last 50.0KB of output");
  });

  test("shortens individual model-facing lines to 500 characters and retains the full output path", async () => {
    const longLine = "a".repeat(700);
    mockPaneOutput(`${longLine}\nPane is dead\n`);

    const result = await executeBash({ command: "print-one-long-line" });
    const output = textResult(result);

    expect(output).toStartWith(`${"a".repeat(500)}... [truncated]`);
    expect(output).toContain("1 line shortened to 500 characters");
    expect(output).toContain(`Full output: ${result.details.fullOutputPath}]`);
    expect(result.details.displayAnsi).toEndWith(output.slice(output.indexOf("[Output truncated:")));
  });

  test("reports non-zero exit codes to the model result without adding them to displayAnsi", async () => {
    mockPaneOutput("\u001b[31mfailure\u001b[0m\nPane is dea", 7);

    const result = await executeBash({ command: "false" });

    expect(textResult(result)).toBe("failure\n\nCommand exited with code 7");
    expect(result.details).toMatchObject({ exitCode: 7, aborted: false, timedOut: false });
    expect(result.details.displayAnsi).toBe("\u001b[31mfailure\u001b[0m");
  });
});
