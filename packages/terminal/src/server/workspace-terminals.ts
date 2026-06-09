import { execWorkspaceShell, AtelierCoreError } from "@atelier/core";

const terminalRoot = "/repos";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface WorkspaceTerminalListResult {
  terminals: Array<{ title: string }>;
}

export interface WorkspaceTerminalCreateResult {
  title: string;
}

export async function listWorkspaceTerminals(id: string): Promise<WorkspaceTerminalListResult> {
  const result = await execWorkspaceShell(id, "tmux list-sessions -F '#S'");
  if (result.exitCode !== 0) return { terminals: [] };
  return { terminals: result.stdout.trim().split(/\n+/).filter(Boolean).map((title) => ({ title })) };
}

export async function createWorkspaceTerminal(id: string): Promise<WorkspaceTerminalCreateResult> {
  const { terminals } = await listWorkspaceTerminals(id);
  const used = new Set<number>();
  for (const { title } of terminals) {
    const match = title.match(/^Terminal (\d+)$/);
    if (match) used.add(Number(match[1]));
  }

  let index = 1;
  while (used.has(index)) index += 1;
  const title = `Terminal ${index}`;

  const result = await execWorkspaceShell(
    id,
    `TERM=xterm-ghostty COLORTERM=truecolor tmux new-session -d -s ${shellQuote(title)} -c ${shellQuote(terminalRoot)} /bin/bash`,
  );
  if (result.exitCode !== 0) throw new AtelierCoreError("terminal_create_failed", result.stderr.trim() || `could not create terminal: ${title}`);

  return { title };
}

export async function deleteWorkspaceTerminal(id: string, title: string): Promise<null> {
  const { terminals } = await listWorkspaceTerminals(id);
  if (!terminals.some((terminal) => terminal.title === title)) {
    throw new AtelierCoreError("terminal_not_found", `terminal not found: ${title}`);
  }

  const result = await execWorkspaceShell(id, `tmux kill-session -t ${shellQuote(title)}`);
  if (result.exitCode !== 0) throw new AtelierCoreError("terminal_delete_failed", result.stderr.trim() || `could not delete terminal: ${title}`);
  return null;
}
