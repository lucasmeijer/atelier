import { shellQuote } from "@atelier/core";
import type { ServerWebSocket } from "bun";
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
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Bash tool that runs commands inside the workspace container under a PTY,
 * via a marked tmux session. Display is decoupled from execution: the browser
 * can attach an inline xterm to the tmux session while the command runs; the
 * tool result is captured from tmux's rendered scrollback and active screen.
 */

export const agentTmuxPrefix = "atelier-agent-";

/** Fixed terminal size for agent bash commands (a normal desktop terminal). */
export const agentTermCols = observableTerminalCols;
export const agentTermRows = observableTerminalRows;

const maxModelOutputBytes = 200_000;
const maxDisplayAnsiBytes = 200_000;
const tmuxHistoryLimit = observableTerminalHistoryLimit;
const pollIntervalMs = 350;

interface TmuxBashHooks {
  /** Called when the tmux session is up: lets the runtime show a live terminal. */
  onSessionStarted?: (toolCallId: string, tmuxSession: string) => void;
}

function byteLimitUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  let used = 0;
  let out = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return { text: out, truncated: true };
}

function plainModelOutput(text: string): string {
  return stripTerminalControls(text).trim();
}

function shellExport(assignments: Record<string, string | number>): string {
  return `export ${Object.entries(assignments).map(([key, value]) => `${key}=${shellQuote(String(value))}`).join(" ")}`;
}

export function stripTmuxPaneFraming(text: string): string {
  return stripObservablePaneFraming(text);
}

export function createTmuxBashTool(workspaceId: string, hooks: TmuxBashHooks = {}): ToolDefinition<any, any> {
  return defineTool({
    name: "bash",
    label: "Bash",
    description: "the bash toolcall will be executed inside of a tmux session for visibility. avoid redirecting output to nowhere. avoid the programs you're invoking from attempting to read from stdin, as that will hang the toolcall.",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 600)" })),
    }),
    execute: async (toolCallId: string, params: { command: string; timeout?: number }, signal?: AbortSignal, onUpdate?: (partial: any) => void) => {
      const sessionName = `${agentTmuxPrefix}${crypto.randomUUID().slice(0, 8)}`;
      const exitFile = `/tmp/${sessionName}.exit`;
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
      // Encourage color in tools that otherwise default to `auto` detection.
      // COLOR is used by CMake-generated Makefiles, FORCE_COLOR by many JS/Rust
      // tools, CLICOLOR_FORCE by BSD-ish tools, and NINJA_STATUS gives direct
      // ninja invocations a colored progress prefix.
      const colorEnv = shellExport({ TERM: "xterm-256color", COLORTERM: "truecolor", COLUMNS: agentTermCols, LINES: agentTermRows, CLICOLOR_FORCE: 1, FORCE_COLOR: 1, COLOR: 1 });
      const ninjaStatus = "export NINJA_STATUS=$(printf '\\033[36m[%%f/%%t %%p]\\033[0m ')";
      // Force the tmux pane's tty size immediately before the command starts. If
      // the size is briefly reported as very narrow, carriage-return progress UIs
      // (for example `git clone`) wrap and then each `\r` returns only to the
      // start of the wrapped physical row, producing concatenated progress text
      // in the live browser terminal.
      const forceTtySize = `stty cols ${agentTermCols} rows ${agentTermRows} 2>/dev/null || true`;
      const runCommand = `(
${forceTtySize}
${params.command}
)
status=$?
printf '%s\\n' "$status" > ${shellQuote(exitFile)}`;
      const inner = `${buildSetRemainOnExitCommand()}; ${forceTtySize}; ${ninjaStatus}; ${colorEnv}; ${guards}; ${runCommand}`;
      const create = await execWorkspaceShell(
        workspaceId,
        buildObservableSessionCommand({ session: sessionName, cwd: workspaceRoot, command: shellQuote(inner), cols: agentTermCols, rows: agentTermRows, fixedSize: true, remainOnExit: true, historyLimit: tmuxHistoryLimit }),
      );
      if (create.exitCode !== 0) throw new Error(create.stderr.trim() || `could not start command session`);

      hooks.onSessionStarted?.(toolCallId, sessionName);
      onUpdate?.({ content: [], details: { tmuxSession: sessionName, command: params.command } });

      const startedAt = Date.now();
      let exitCode: number | undefined;
      for (;;) {
        if (signal?.aborted) {
          await execWorkspaceShell(workspaceId, buildSendInterruptCommand(sessionName));
          break;
        }
        const probe = await execWorkspaceShell(workspaceId, `cat ${shellQuote(exitFile)} 2>/dev/null`);
        const text = probe.stdout.trim();
        if (text !== "") {
          exitCode = Number(text);
          break;
        }
        if (Date.now() - startedAt > timeoutMs) {
          await execWorkspaceShell(workspaceId, buildSendInterruptCommand(sessionName));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      // Capture tmux's rendered scrollback and active screen. Plain capture feeds
      // the model; ANSI-preserving capture feeds the UI terminal view.
      const modelPane = await execWorkspaceShell(workspaceId, buildCapturePaneCommand({ session: sessionName, historyLimit: tmuxHistoryLimit, ansi: false }));
      const displayPane = await execWorkspaceShell(workspaceId, buildCapturePaneCommand({ session: sessionName, historyLimit: tmuxHistoryLimit }));
      await execWorkspaceShell(workspaceId, `${buildKillSessionCommand(sessionName)}; rm -f ${shellQuote(exitFile)}; true`);

      const modelLimited = byteLimitUtf8(stripTmuxPaneFraming(modelPane.stdout), maxModelOutputBytes);
      let output = plainModelOutput(modelLimited.text);
      if (modelLimited.truncated) output += `\n… output truncated at ${maxModelOutputBytes} bytes`;
      const displayLimited = byteLimitUtf8(stripTmuxPaneFraming(displayPane.stdout), maxDisplayAnsiBytes);
      let displayAnsi = normalizeCarriageReturns(displayLimited.text).trimEnd();
      if (displayLimited.truncated) displayAnsi += `\n… output truncated at ${maxDisplayAnsiBytes} bytes`;
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
          tmuxSession: sessionName,
          displayAnsi,
          aborted,
          timedOut,
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Inline terminal websocket: read-only attach to an agent tmux session.
// ---------------------------------------------------------------------------

interface AgentTermSocketData {
  kind: "agent-term";
  workspaceId: string;
  session: string;
  cols: number;
  rows: number;
  pty?: IPty;
}

export function validateAgentTermSocket(url: URL): AgentTermSocketData | undefined {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/agent-term\/([^/]+)\/ws$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1]);
  const session = decodeURIComponent(match[2]);
  if (!session.startsWith(agentTmuxPrefix)) return undefined;
  return {
    kind: "agent-term",
    workspaceId,
    session,
    // Agent bash sessions have a fixed, desktop-like size. Do not trust the
    // browser/PTY-reported attach size here: hidden or freshly-mounted inline
    // terminals can briefly report tiny dimensions (for example 5x5), and a
    // tmux attach client may otherwise propagate that size to the running
    // command.
    cols: agentTermCols,
    rows: agentTermRows,
  };
}

export function openAgentTermSocket(ws: ServerWebSocket<AgentTermSocketData>): void {
  const data = ws.data;
  try {
    const pty = attachObservableTerminal({
      containerName: workspaceContainerName(data.workspaceId),
      session: data.session,
      cols: data.cols,
      rows: data.rows,
      user: "atelier",
      readonly: true,
      fixedSize: true,
    });
    data.pty = pty;
    pty.onData((chunk) => {
      setTimeout(() => {
        try {
          ws.send(chunk);
        } catch {
          // Socket closed.
        }
      }, 0);
    });
    pty.onExit(() => ws.close());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ws.send(`\r\n[terminal attach failed: ${message}]\r\n`);
    ws.close();
  }
}

export function handleAgentTermSocketMessage(_ws: ServerWebSocket<AgentTermSocketData>, _message: string | Buffer): void {
  // Read-only attach with a fixed window size: ignore all input and resizes.
}

export function closeAgentTermSocket(ws: ServerWebSocket<AgentTermSocketData>): void {
  ws.data.pty?.kill();
}
