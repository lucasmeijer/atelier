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

const maxToolOutputBytes = 200_000;
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

/** Remove the `script` typescript header/footer lines from captured output. */
function stripScriptFraming(text: string): string {
  return text
    .replace(/^Script started on [^\n]*\n?/, "")
    .replace(/\n?Script done on [^\n]*\n?$/, "");
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
      // independent of any attached viewer. The tmux session exists purely for
      // live viewing and dies when the command completes.
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
      const inner = `${guards} script -qefc ${shellQuote(params.command)} ${shellQuote(outFile)}; echo $? > ${shellQuote(exitFile)}`;
      // Fixed desktop-like terminal size; `window-size manual` stops attached
      // viewers (the inline xterm) from resizing the command's terminal.
      const create = await execWorkspaceShell(
        workspaceId,
        `TERM=xterm-256color tmux new-session -d -s ${shellQuote(sessionName)} -x ${agentTermCols} -y ${agentTermRows} -c /repos ${shellQuote(inner)} \\; set-option -t ${shellQuote(sessionName)} window-size manual \\; set-option -t ${shellQuote(sessionName)} status off`,
      );
      if (create.exitCode !== 0) throw new Error(create.stderr.trim() || `could not start command session`);

      hooks.onSessionStarted?.(toolCallId, sessionName);
      onUpdate?.({ content: [], details: { tmuxSession: sessionName, command: params.command } });

      const startedAt = Date.now();
      let exitCode: number | undefined;
      for (;;) {
        if (signal?.aborted) {
          await execWorkspaceShell(workspaceId, `tmux kill-session -t ${shellQuote(sessionName)} 2>/dev/null; true`);
          break;
        }
        const probe = await execWorkspaceShell(workspaceId, `cat ${shellQuote(exitFile)} 2>/dev/null`);
        const text = probe.stdout.trim();
        if (text !== "") {
          exitCode = Number(text);
          break;
        }
        if (Date.now() - startedAt > timeoutMs) {
          await execWorkspaceShell(workspaceId, `tmux kill-session -t ${shellQuote(sessionName)} 2>/dev/null; true`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      // Capture whatever output exists, then clean up.
      const captured = await execWorkspaceCommand(workspaceId, ["sh", "-c", `head -c ${maxToolOutputBytes + 1} ${shellQuote(outFile)} 2>/dev/null`]);
      const raw = captured.stdout;
      await execWorkspaceShell(workspaceId, `rm -f ${shellQuote(outFile)} ${shellQuote(exitFile)}; true`);
      const truncated = raw.length > maxToolOutputBytes;
      let output = stripScriptFraming(stripAnsi(truncated ? raw.slice(0, maxToolOutputBytes) : raw)).trim();
      if (truncated) output += `\n… output truncated at ${maxToolOutputBytes} bytes`;
      const aborted = signal?.aborted ?? false;
      const timedOut = exitCode === undefined && !aborted;
      const body = output || "(no output)";
      if (aborted) throw new Error(`${body}\n\nCommand aborted`);
      if (timedOut) throw new Error(`${body}\n\nCommand timed out after ${Math.round(timeoutMs / 1000)} seconds`);
      if (exitCode !== 0) throw new Error(`${body}\n\nCommand exited with code ${exitCode}`);
      return {
        content: [{ type: "text" as const, text: body }],
        details: { exitCode, tmuxSession: sessionName },
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

function parsePositiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : fallback;
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
    cols: parsePositiveInteger(url.searchParams.get("cols"), 80),
    rows: parsePositiveInteger(url.searchParams.get("rows"), 24),
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
      "tmux", "attach-session", "-r", "-t", data.session,
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
