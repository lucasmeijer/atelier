import { shellQuote } from "@atelier/core";
import type { WorkspaceServerSocketSession, WorkspaceSocketConnection } from "@atelier/shared";
import { execWorkspaceShell, workspaceContainerName, workspaceRoot } from "@atelier/workspace";
import {
  attachObservableTerminal,
  buildCapturePaneCommand,
  buildKillSessionCommand,
  buildObservableSessionCommand,
  buildSendInterruptCommand,
  buildSetRemainOnExitCommand,
  normalizeCarriageReturns,
  observableTerminalCols,
  observableTerminalHistoryLimit,
  observableTerminalRows,
  stripObservablePaneFraming,
  stripTerminalControls,
  type IPty,
} from "@atelier/observable-terminal/server";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateLine,
  truncateTail,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Bash tool that runs commands inside the workspace container under a PTY,
 * via a marked tmux session. Display is decoupled from execution: the browser
 * can attach an inline terminal to the tmux session while the command runs; the
 * tool result is captured from tmux's rendered scrollback and active screen.
 */

export const agentTmuxPrefix = "atelier-agent-";

/** Fixed terminal size for agent bash commands (a normal desktop terminal). */
export const agentTermCols = observableTerminalCols;
export const agentTermRows = observableTerminalRows;

const maxModelLineChars = 500;
const maxDisplayAnsiBytes = 200_000;
const tmuxHistoryLimit = observableTerminalHistoryLimit;
const pollIntervalMs = 350;

/**
 * Color conventions understood by the most common build-tool ecosystems.
 *
 * TERM/COLORTERM advertise terminal capabilities. CLICOLOR is the general
 * opt-in convention and CLICOLOR_FORCE makes it unconditional. FORCE_COLOR is
 * the equivalent convention used broadly by JavaScript and Rust CLIs. The
 * remaining variables cover CMake/Make, Cargo/Rust loggers, Python tools, and
 * .NET respectively.
 */
export const forcedColorEnvironment = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  CLICOLOR: 1,
  CLICOLOR_FORCE: 1,
  FORCE_COLOR: 1,
  COLOR: 1,
  CMAKE_COLOR_DIAGNOSTICS: "ON",
  CARGO_TERM_COLOR: "always",
  RUST_LOG_STYLE: "always",
  PY_COLORS: 1,
  DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION: 1,
} as const;

type ExecWorkspaceShell = typeof execWorkspaceShell;

interface LimitedModelLines {
  text: string;
  linesTruncated: number;
}

function plainModelOutput(text: string): string {
  return stripTerminalControls(text).trimEnd();
}

function limitModelLines(text: string): LimitedModelLines {
  let linesTruncated = 0;
  const lines = text.split("\n").map((line) => {
    const limited = truncateLine(line, maxModelLineChars);
    if (limited.wasTruncated) linesTruncated += 1;
    return limited.text;
  });
  return { text: lines.join("\n"), linesTruncated };
}

function shellExport(assignments: Record<string, string | number>): string {
  return `export ${Object.entries(assignments).map(([key, value]) => `${key}=${shellQuote(String(value))}`).join(" ")}`;
}

export function stripTmuxPaneFraming(text: string): string {
  return stripObservablePaneFraming(text);
}

export function createTmuxBashTool(
  workspaceId: string,
  runWorkspaceShell: ExecWorkspaceShell = execWorkspaceShell,
): ToolDefinition<any, any> {
  return defineTool({
    name: "bash",
    label: "Bash",
    description: `the bash toolcall will be executed inside of a tmux session for visibility. output shown to the model is limited to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB, and individual lines are shortened to ${maxModelLineChars} characters; truncated full output is saved to a temporary file. avoid redirecting output to nowhere. avoid the programs you're invoking from attempting to read from stdin, as that will hang the toolcall.`,
    parameters: Type.Object({
      command: Type.String({ description: "The bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 600)" })),
    }),
    execute: async (_toolCallId: string, params: { command: string; timeout?: number }, signal?: AbortSignal, onUpdate?: (partial: any) => void) => {
      const sessionName = `${agentTmuxPrefix}${crypto.randomUUID().slice(0, 8)}`;
      const exitFile = `/tmp/${sessionName}.exit`;
      const fullOutputPath = `/tmp/${sessionName}.log`;
      const timeoutMs = Math.max(1, params.timeout ?? 600) * 1000;

      // Interactive editors/pagers/prompts are neutralized (GIT_EDITOR=true,
      // PAGER=cat, GIT_TERMINAL_PROMPT=0) so commands like a bare `git commit`
      // fail fast instead of opening vim. stdin stays on the PTY — full-screen
      // programs (ncurses, progress UIs) need a tty on stdin to render.
      //
      // The command runs directly in tmux's PTY. After it exits, the model and
      // UI outputs are both captured from tmux's rendered scrollback and active
      // screen: plain capture for the model, ANSI-preserving capture for UI.
      const guards = shellExport({ EDITOR: "true", GIT_EDITOR: "true", VISUAL: "true", GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: 0 });
      // Encourage color even when a tool second-guesses the PTY. NO_COLOR must
      // be removed because it is the standard opt-out and may be inherited from
      // the Atelier process. NINJA_STATUS has no boolean color switch, so give
      // direct Ninja invocations an explicitly colored progress prefix.
      const colorEnv = `unset NO_COLOR; ${shellExport({ ...forcedColorEnvironment, COLUMNS: agentTermCols, LINES: agentTermRows })}`;
      const ninjaStatus = "export NINJA_STATUS=$(printf '\\033[36m[%%f/%%t %%p]\\033[0m ')";
      // Force the tmux pane's tty size immediately before the command starts. If
      // the size is briefly reported as very narrow, carriage-return progress UIs
      // (for example `git clone`) wrap and then each `\r` returns only to the
      // start of the wrapped physical row, producing concatenated progress text
      // in the live browser terminal.
      const forceTtySize = `stty cols ${agentTermCols} rows ${agentTermRows} 2>/dev/null || true`;
      // Capture the complete PTY stream before the command starts. The retained
      // file is only advertised when the model-facing result is truncated.
      const captureFullOutput = `tmux pipe-pane -o -t "$TMUX_PANE" ${shellQuote(`umask 077; cat > ${shellQuote(fullOutputPath)}`)}`;
      const runCommand = `(
${forceTtySize}
${params.command}
)
status=$?
printf '%s\\n' "$status" > ${shellQuote(exitFile)}`;
      const inner = `${buildSetRemainOnExitCommand()}; ${captureFullOutput}; ${forceTtySize}; ${ninjaStatus}; ${colorEnv}; ${guards}; ${runCommand}`;
      const create = await runWorkspaceShell(
        workspaceId,
        buildObservableSessionCommand({ session: sessionName, cwd: workspaceRoot, command: shellQuote(inner), cols: agentTermCols, rows: agentTermRows, fixedSize: true, remainOnExit: true, historyLimit: tmuxHistoryLimit }),
      );
      if (create.exitCode !== 0) throw new Error(create.stderr.trim() || `could not start command session`);

      onUpdate?.({ content: [], details: { tmuxSession: sessionName, command: params.command } });

      const startedAt = Date.now();
      let exitCode: number | undefined;
      for (;;) {
        if (signal?.aborted) {
          await runWorkspaceShell(workspaceId, buildSendInterruptCommand(sessionName));
          break;
        }
        const probe = await runWorkspaceShell(workspaceId, `cat ${shellQuote(exitFile)} 2>/dev/null`);
        const text = probe.stdout.trim();
        if (text !== "") {
          exitCode = Number(text);
          break;
        }
        if (Date.now() - startedAt > timeoutMs) {
          await runWorkspaceShell(workspaceId, buildSendInterruptCommand(sessionName));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      // Capture tmux's rendered scrollback and active screen. Plain capture feeds
      // the model; ANSI-preserving capture feeds the UI terminal view.
      const modelPane = await runWorkspaceShell(workspaceId, buildCapturePaneCommand({ session: sessionName, historyLimit: tmuxHistoryLimit, ansi: false }));
      const displayPane = await runWorkspaceShell(workspaceId, buildCapturePaneCommand({ session: sessionName, historyLimit: tmuxHistoryLimit }));

      const modelLines = limitModelLines(plainModelOutput(stripTmuxPaneFraming(modelPane.stdout)));
      const modelLimited = truncateTail(modelLines.text);
      let output = modelLimited.content;
      const modelTruncated = modelLimited.truncated || modelLines.linesTruncated > 0;
      let truncationNotice = "";
      if (modelTruncated) {
        const reasons = [];
        if (modelLimited.truncated) reasons.push(`showing the last ${formatSize(modelLimited.outputBytes)} of output`);
        if (modelLines.linesTruncated > 0) reasons.push(`${modelLines.linesTruncated} line${modelLines.linesTruncated === 1 ? "" : "s"} shortened to ${maxModelLineChars} characters`);
        truncationNotice = `[Output truncated: ${reasons.join("; ")}. Full output: ${fullOutputPath}]`;
        output += `\n\n${truncationNotice}`;
      }

      const displayLimited = truncateTail(stripTmuxPaneFraming(displayPane.stdout), { maxBytes: maxDisplayAnsiBytes, maxLines: Number.MAX_SAFE_INTEGER });
      let displayAnsi = normalizeCarriageReturns(displayLimited.content).trimEnd();
      if (displayLimited.truncated) displayAnsi = `… output truncated to last ${maxDisplayAnsiBytes} bytes\n${displayAnsi}`;
      if (truncationNotice) displayAnsi += `\n\n${truncationNotice}`;

      const removeFullOutput = modelTruncated ? "" : `rm -f ${shellQuote(fullOutputPath)}; `;
      await runWorkspaceShell(workspaceId, `${buildKillSessionCommand(sessionName)}; rm -f ${shellQuote(exitFile)}; ${removeFullOutput}true`);
      const aborted = signal?.aborted ?? false;
      const timedOut = exitCode === undefined && !aborted;
      let body = output || "(no output)";
      if (aborted) body = `${body}\n\nCommand aborted`;
      else if (timedOut) body = `${body}\n\nCommand timed out after ${Math.round(timeoutMs / 1000)} seconds`;
      else if (exitCode !== 0) body = `${body}\n\nCommand exited with code ${exitCode}`;

      return {
        content: [{ type: "text" as const, text: body }],
        details: {
          exitCode,
          displayAnsi,
          aborted,
          timedOut,
          fullOutputPath: modelTruncated ? fullOutputPath : undefined,
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Inline terminal websocket: read-only attach to an agent tmux session.
// ---------------------------------------------------------------------------

interface AgentTermSocketData {
  workspaceId: string;
  session: string;
  pty?: IPty;
}

export function createAgentTermSocketSession(url: URL): WorkspaceServerSocketSession | undefined {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/agent-term\/([^/]+)\/ws$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1]);
  const session = decodeURIComponent(match[2]);
  if (!session.startsWith(agentTmuxPrefix)) return undefined;
  const data: AgentTermSocketData = {
    workspaceId,
    session,
  };
  return {
    open: (socket) => openAgentTermSocket(socket, data),
    close: () => closeAgentTermSocket(data),
  };
}

function openAgentTermSocket(socket: WorkspaceSocketConnection, data: AgentTermSocketData): void {
  try {
    const pty = attachObservableTerminal({
      containerName: workspaceContainerName(data.workspaceId),
      session: data.session,
      // Agent bash sessions have a fixed, desktop-like size. Do not trust the
      // browser/PTY-reported attach size here: hidden or freshly-mounted inline
      // terminals can briefly report tiny dimensions (for example 5x5), and a
      // tmux attach client may otherwise propagate that size to the running
      // command.
      cols: agentTermCols,
      rows: agentTermRows,
      user: "atelier",
      readonly: true,
      fixedSize: true,
    });
    data.pty = pty;
    pty.onData((chunk) => {
      setTimeout(() => {
        try {
          socket.send(chunk);
        } catch {
          // Socket closed.
        }
      }, 0);
    });
    pty.onExit(() => socket.close());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    socket.send(`\r\n[terminal attach failed: ${message}]\r\n`);
    socket.close();
  }
}

function closeAgentTermSocket(data: AgentTermSocketData): void {
  data.pty?.kill();
}
