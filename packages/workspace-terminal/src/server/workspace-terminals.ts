import { AtelierCoreError, type AtelierEventBus } from "@atelier/core";
import { execWorkspaceShell, workspaceRoot } from "@atelier/workspace";
import { buildKillSessionCommand, buildListSessionsCommand, buildObservableSessionCommand, shellQuote } from "@atelier/observable-terminal/server";

const terminalRoot = workspaceRoot;

export interface WorkspaceTerminalListResult {
  terminals: Array<{ title: string }>;
}

export interface WorkspaceTerminalCreateOptions {
  /** Preferred session / tab title. If already used, a numeric suffix is added. */
  title?: string;
  /** Command to run in the terminal instead of opening an idle bash shell. */
  command?: string;
  /** Working directory for the terminal session. Must stay under /work. */
  cwd?: string;
  /** Event bus used to notify the web UI that the workspace tab set changed. */
  events?: AtelierEventBus;
}

export interface WorkspaceTerminalCreateResult {
  title: string;
}

export async function listWorkspaceTerminals(id: string): Promise<WorkspaceTerminalListResult> {
  let result;
  try {
    result = await execWorkspaceShell(id, buildListSessionsCommand());
  } catch {
    return { terminals: [] };
  }
  if (result.exitCode !== 0) return { terminals: [] };
  return {
    terminals: result.stdout
      .trim()
      .split(/\n+/)
      .filter(Boolean)
      .filter((title) => !title.startsWith("atelier-agent-"))
      .map((title) => ({ title })),
  };
}

function terminalTitle(terminals: WorkspaceTerminalListResult["terminals"], preferred?: string): string {
  const existing = new Set(terminals.map((terminal) => terminal.title));
  const base = (preferred ?? "").trim() || "Terminal";
  if (base !== "Terminal" && !existing.has(base)) return base;

  const used = new Set<number>();
  const pattern = base === "Terminal" ? /^Terminal (\d+)$/ : new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+)$`);
  for (const { title } of terminals) {
    const match = title.match(pattern);
    if (match) used.add(Number(match[1]));
  }

  let index = 1;
  while (used.has(index) || existing.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function normalizeCwd(cwd: string | undefined): string {
  const value = (cwd ?? terminalRoot).trim() || terminalRoot;
  if (value !== terminalRoot && !value.startsWith(`${terminalRoot}/`)) {
    throw new AtelierCoreError("terminal_invalid_cwd", `terminal cwd must be under ${terminalRoot}: ${value}`);
  }
  return value;
}

function sessionCommand(command: string | undefined): string {
  const trimmed = command?.trim();
  if (!trimmed) return "/bin/bash";
  const script = `${trimmed}\nstatus=$?\nprintf '\\n[process exited with code %s]\\n' "$status"\nexec /bin/bash`;
  return `/bin/bash -lc ${shellQuote(script)}`;
}

export async function createWorkspaceTerminal(id: string, options: WorkspaceTerminalCreateOptions = {}): Promise<WorkspaceTerminalCreateResult> {
  const { terminals } = await listWorkspaceTerminals(id);
  const title = terminalTitle(terminals, options.title);
  const cwd = normalizeCwd(options.cwd);
  const command = sessionCommand(options.command);

  const result = await execWorkspaceShell(id, buildObservableSessionCommand({ session: title, cwd, command, passthrough: true, status: false }));
  if (result.exitCode !== 0) throw new AtelierCoreError("terminal_create_failed", result.stderr.trim() || `could not create terminal: ${title}`);

  await options.events?.emit("workspace_tabs_changed", { workspaceId: id });
  return { title };
}

export async function deleteWorkspaceTerminal(id: string, title: string): Promise<null> {
  const { terminals } = await listWorkspaceTerminals(id);
  if (!terminals.some((terminal) => terminal.title === title)) {
    throw new AtelierCoreError("terminal_not_found", `terminal not found: ${title}`);
  }

  const result = await execWorkspaceShell(id, buildKillSessionCommand(title));
  if (result.exitCode !== 0) throw new AtelierCoreError("terminal_delete_failed", result.stderr.trim() || `could not delete terminal: ${title}`);
  return null;
}
