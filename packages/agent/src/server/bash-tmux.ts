import { spawn, type IPty } from "@zenyr/bun-pty";
import type { ServerWebSocket } from "bun";
import { execWorkspaceCommand, execWorkspaceShell, workspaceContainerName } from "@atelier/core";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Bash tool that runs commands inside the workspace container under a PTY,
 * via a marked tmux session. Display is decoupled from execution: the browser
 * can attach an inline xterm to the tmux session while the command runs; the
 * tool result is captured independently with `script`, so it is complete even
 * when no browser is attached.
 */

export const agentTmuxPrefix = "atelier-agent-";

/** Fixed terminal size for agent bash commands (a normal desktop terminal). */
export const agentTermCols = 120;
export const agentTermRows = 30;

const maxModelOutputBytes = 200_000;
const maxDisplayAnsiBytes = 200_000;
const tmuxHistoryLimit = 100_000;
const pollIntervalMs = 350;

export interface TmuxBashHooks {
  /** Called when the tmux session is up: lets the runtime show a live terminal. */
  onSessionStarted?: (toolCallId: string, tmuxSession: string) => void;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
    .replace(/\u001b[()][0-9A-B]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/^.*\r(?!\n)/gm, "");
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

/** Remove the `script` typescript header/footer lines from captured output. */
function stripScriptFraming(text: string): string {
  return text
    .replace(/^Script started on [^\n]*\n?/, "")
    .replace(/\n?Script done on [^\n]*\n?$/, "");
}

/** Remove tmux's remain-on-exit marker from captured panes. */
function stripTmuxPaneFraming(text: string): string {
  return text.replace(/(?:\n|\r|\u001b\[[0-9;?]*[a-zA-Z])*Pane is dead\n?$/, "");
}

export function createTmuxBashTool(workspaceId: string, hooks: TmuxBashHooks = {}): ToolDefinition<any, any> {
  return defineTool({
    name: "bash",
    label: "Bash",
    description: "Execute a bash command inside the workspace container (under a PTY; interactive progress output is fine). Returns stdout+stderr and the exit code. The working directory is /repos.",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 600)" })),
    }),
    execute: async (toolCallId: string, params: { command: string; timeout?: number }, signal?: AbortSignal, onUpdate?: (partial: any) => void) => {
      const sessionName = `${agentTmuxPrefix}${crypto.randomUUID().slice(0, 8)}`;
      const outFile = `/tmp/${sessionName}.out`;
      const exitFile = `/tmp/${sessionName}.exit`;
      const timeoutMs = Math.max(1, params.timeout ?? 600) * 1000;

      // `script` runs the command under a PTY and tees everything to outFile,
      // independent of any attached viewer. The tmux session exists for live
      // viewing and final ANSI-preserving pane capture.
      //
      // Interactive editors/pagers/prompts are neutralized (GIT_EDITOR=true,
      // PAGER=cat, GIT_TERMINAL_PROMPT=0) so commands like a bare `git commit`
      // fail fast instead of opening vim. stdin stays on the PTY — full-screen
      // programs (ncurses, progress UIs) need a tty on stdin to render.
      //
      // The command goes straight to `script -c` (which runs it via sh -c
      // itself). Do NOT add another sh wrapper: an extra shell between script
      // and the command lands the command in a background process group and
      // full-screen programs get stopped by SIGTTOU before drawing anything.
      const guards = "EDITOR=true GIT_EDITOR=true VISUAL=true GIT_PAGER=cat PAGER=cat GIT_TERMINAL_PROMPT=0";
      // Encourage color in tools that otherwise default to `auto` detection.
      // The AI-facing result is still ANSI-stripped; these settings are for the
      // tmux/UI display channel. COLOR is used by CMake-generated Makefiles,
      // FORCE_COLOR by many JS/Rust tools, CLICOLOR_FORCE by BSD-ish tools, and
      // NINJA_STATUS gives direct ninja invocations a colored progress prefix.
      const colorEnv = "TERM=xterm-256color COLORTERM=truecolor CLICOLOR_FORCE=1 FORCE_COLOR=1 COLOR=1";
      const ninjaStatus = "NINJA_STATUS=$(printf '\\033[36m[%%f/%%t %%p]\\033[0m ')";
      const inner = `tmux set-window-option remain-on-exit on; ${ninjaStatus} ${colorEnv} ${guards} script -qefc ${shellQuote(params.command)} ${shellQuote(outFile)}; echo $? > ${shellQuote(exitFile)}`;
      // Fixed desktop-like terminal size; `window-size manual` stops attached
      // viewers (the inline xterm) from resizing the command's terminal.
      const create = await execWorkspaceShell(
        workspaceId,
        `TERM=xterm-256color tmux new-session -d -s ${shellQuote(sessionName)} -x ${agentTermCols} -y ${agentTermRows} -c /repos ${shellQuote(inner)} \\; set-option -t ${shellQuote(sessionName)} window-size manual \\; set-option -t ${shellQuote(sessionName)} status off \\; set-option -t ${shellQuote(sessionName)} history-limit ${tmuxHistoryLimit}`,
      );
      if (create.exitCode !== 0) throw new Error(create.stderr.trim() || `could not start command session`);

      hooks.onSessionStarted?.(toolCallId, sessionName);
      onUpdate?.({ content: [], details: { tmuxSession: sessionName, command: params.command } });

      const startedAt = Date.now();
      let exitCode: number | undefined;
      for (;;) {
        if (signal?.aborted) {
          await execWorkspaceShell(workspaceId, `tmux send-keys -t ${shellQuote(sessionName)} C-c 2>/dev/null; true`);
          break;
        }
        const probe = await execWorkspaceShell(workspaceId, `cat ${shellQuote(exitFile)} 2>/dev/null`);
        const text = probe.stdout.trim();
        if (text !== "") {
          exitCode = Number(text);
          break;
        }
        if (Date.now() - startedAt > timeoutMs) {
          await execWorkspaceShell(workspaceId, `tmux send-keys -t ${shellQuote(sessionName)} C-c 2>/dev/null; true`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      // Capture whatever output exists. The model result comes from `script`'s
      // raw log and is stripped of terminal control codes; the UI result comes
      // from tmux scrollback with SGR color escapes preserved (`capture-pane -e`).
      const captured = await execWorkspaceCommand(workspaceId, ["sh", "-c", `head -c ${maxModelOutputBytes + 1} ${shellQuote(outFile)} 2>/dev/null`]);
      const raw = captured.stdout;
      const pane = await execWorkspaceShell(workspaceId, `tmux capture-pane -p -e -J -S -${tmuxHistoryLimit} -t ${shellQuote(sessionName)} 2>/dev/null || true`);
      await execWorkspaceShell(workspaceId, `tmux kill-session -t ${shellQuote(sessionName)} 2>/dev/null; rm -f ${shellQuote(outFile)} ${shellQuote(exitFile)}; true`);

      const modelLimited = byteLimitUtf8(raw, maxModelOutputBytes);
      let output = stripScriptFraming(stripAnsi(modelLimited.text)).trim();
      if (modelLimited.truncated) output += `\n… output truncated at ${maxModelOutputBytes} bytes`;
      const aborted = signal?.aborted ?? false;
      const timedOut = exitCode === undefined && !aborted;
      let body = output || "(no output)";
      if (aborted) body = `${body}\n\nCommand aborted`;
      else if (timedOut) body = `${body}\n\nCommand timed out after ${Math.round(timeoutMs / 1000)} seconds`;
      else if (exitCode !== 0) body = `${body}\n\nCommand exited with code ${exitCode}`;

      const displayLimited = byteLimitUtf8(stripTmuxPaneFraming(pane.stdout) || raw, maxDisplayAnsiBytes);
      let displayAnsi = stripScriptFraming(displayLimited.text).trimEnd();
      if (displayLimited.truncated) displayAnsi += `\n… output truncated at ${maxDisplayAnsiBytes} bytes`;
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

export interface AgentTermSocketData {
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
    const pty = spawn("docker", [
      "exec", "-it",
      "--user", "atelier",
      "-e", "TERM=xterm-256color",
      workspaceContainerName(data.workspaceId),
      "tmux",
      "set-option", "-t", data.session, "window-size", "manual", "\;",
      "resize-window", "-t", data.session, "-x", String(agentTermCols), "-y", String(agentTermRows), "\;",
      "attach-session", "-r", "-t", data.session,
    ], {
      name: "xterm-256color",
      cols: data.cols,
      rows: data.rows,
      env: { ...process.env, TERM: "xterm-256color" },
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
