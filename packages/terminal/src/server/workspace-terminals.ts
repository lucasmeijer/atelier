import { execWorkspaceShell, AtelierCoreError, workspaceRoot, type AtelierEventBus } from "@atelier/core";

const terminalRoot = workspaceRoot;
const terminalEnvironment = "LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color COLORTERM=truecolor";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface WorkspaceTerminalListResult {
  terminals: Array<{ title: string }>;
}

export interface WorkspaceTerminalCreateOptions {
  /** Preferred tmux session / tab title. If already used, a numeric suffix is added. */
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
    result = await execWorkspaceShell(id, "tmux list-sessions -F '#S'");
  } catch {
    // Container or docker unavailable: no terminals rather than a hard failure.
    return { terminals: [] };
  }
  if (result.exitCode !== 0) return { terminals: [] };
  return {
    terminals: result.stdout
      .trim()
      .split(/\n+/)
      .filter(Boolean)
      // Agent tool sessions (atelier-agent-*) are internal; never list them as terminal tabs.
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

function tmuxSessionCommand(command: string | undefined): string {
  const trimmed = command?.trim();
  if (!trimmed) return "/bin/bash";
  const script = `${trimmed}\nstatus=$?\nprintf '\\n[process exited with code %s]\\n' "$status"\nexec /bin/bash`;
  return `/bin/bash -lc ${shellQuote(script)}`;
}

export async function createWorkspaceTerminal(id: string, options: WorkspaceTerminalCreateOptions = {}): Promise<WorkspaceTerminalCreateResult> {
  const { terminals } = await listWorkspaceTerminals(id);
  const title = terminalTitle(terminals, options.title);
  const cwd = normalizeCwd(options.cwd);
  const command = tmuxSessionCommand(options.command);

  const result = await execWorkspaceShell(
    id,
    `${terminalEnvironment} tmux set-option -g allow-passthrough on \\; set-option -g status off \\; set-environment -g LANG C.UTF-8 \\; set-environment -g LC_ALL C.UTF-8 \\; set-environment -g TERM xterm-256color \\; set-environment -g COLORTERM truecolor \\; new-session -d -s ${shellQuote(title)} -c ${shellQuote(cwd)} ${command} \\; set-option -t ${shellQuote(title)} status off`,
  );
  if (result.exitCode !== 0) throw new AtelierCoreError("terminal_create_failed", result.stderr.trim() || `could not create terminal: ${title}`);

  await options.events?.emit("workspace_tabs_changed", { workspaceId: id });
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
