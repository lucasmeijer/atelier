import { spawn, type IPty } from "@zenyr/bun-pty";
import type { ServerWebSocket } from "bun";
import { AtelierCoreError } from "@atelier/core";
import { listWorkspaceTerminals } from "./workspace-terminals.ts";

export interface TerminalSocketData {
  kind: "terminal";
  workspaceId: string;
  title: string;
  cols: number;
  rows: number;
  pty?: IPty;
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : fallback;
}

export async function validateTerminalSocket(url: URL): Promise<TerminalSocketData | undefined> {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs\/([^/]+)\/ws$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1]);
  const tabId = decodeURIComponent(match[2]);
  if (!tabId.startsWith("terminal:")) return undefined;
  const title = tabId.slice("terminal:".length);
  const { terminals } = await listWorkspaceTerminals(workspaceId);
  if (!terminals.some((terminal) => terminal.title === title)) throw new AtelierCoreError("terminal_not_found", `terminal not found: ${title}`);
  return {
    kind: "terminal",
    workspaceId,
    title,
    cols: parsePositiveInteger(url.searchParams.get("cols"), 80),
    rows: parsePositiveInteger(url.searchParams.get("rows"), 24),
  };
}

export function openTerminalSocket(ws: ServerWebSocket<TerminalSocketData>): void {
  const data = ws.data;
  const args = [
    "exec", "-it",
    "--user", "atelier",
    "--workdir", "/repos",
    "-e", "TERM=xterm-ghostty",
    "-e", "COLORTERM=truecolor",
    "-e", "LANG=C.UTF-8",
    "-e", "LC_ALL=C.UTF-8",
    data.workspaceId,
    "tmux", "attach-session", "-t", data.title,
  ];
  try {
    const pty = spawn("docker", args, {
      name: "xterm-ghostty",
      cols: data.cols,
      rows: data.rows,
      env: { ...process.env, TERM: "xterm-ghostty", COLORTERM: "truecolor", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    });
    data.pty = pty;
    pty.onData((chunk) => {
      setTimeout(() => {
        try {
          ws.send(chunk);
        } catch {
          // Socket closed between PTY output and scheduled send.
        }
      }, 0);
    });
    pty.onExit(() => ws.close());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ws.send(`\r\n\x1b[31m[terminal failed to start: ${message}]\x1b[0m\r\n`);
    ws.close();
  }
}

export function handleTerminalSocketMessage(ws: ServerWebSocket<TerminalSocketData>, message: string | Buffer): void {
  const text = typeof message === "string" ? message : message.toString();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "resize") {
      const cols = Number((parsed as { cols?: unknown }).cols);
      const rows = Number((parsed as { rows?: unknown }).rows);
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) ws.data.pty?.resize(cols, rows);
      return;
    }
  } catch {
    // Raw terminal input is not JSON.
  }
  ws.data.pty?.write(text);
}

export function closeTerminalSocket(ws: ServerWebSocket<TerminalSocketData>): void {
  ws.data.pty?.kill();
}
