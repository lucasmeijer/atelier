import { shellQuote } from "@atelier/core";
import { observableTerminalCols, observableTerminalEnvironment, observableTerminalHistoryLimit, observableTerminalRows } from "./constants.ts";

export interface ObservableTerminalSessionOptions {
  session: string;
  cwd: string;
  command: string;
  cols?: number;
  rows?: number;
  fixedSize?: boolean;
  remainOnExit?: boolean;
  historyLimit?: number;
  status?: boolean;
  passthrough?: boolean;
  env?: Record<string, string>;
}

function envPrefix(env: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(env)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${shellQuote(String(value))}`)
    .join(" ");
}

function observableTerminalEnvPrefix(extra: Record<string, string | number | boolean | undefined> = {}): string {
  return envPrefix({ ...observableTerminalEnvironment, ...extra });
}

export function buildObservableSessionCommand(options: ObservableTerminalSessionOptions): string {
  const cols = options.cols ?? observableTerminalCols;
  const rows = options.rows ?? observableTerminalRows;
  const setup: string[] = [];
  if (options.passthrough) setup.push("set-option -g allow-passthrough on");
  setup.push(`set-option -g status ${options.status === true ? "on" : "off"}`);
  for (const [key, value] of Object.entries({ ...observableTerminalEnvironment, ...options.env })) {
    if (value !== undefined) setup.push(`set-environment -g ${key} ${shellQuote(String(value))}`);
  }
  const target = shellQuote(options.session);
  const flags = ["new-session", "-d", "-s", target];
  if (options.fixedSize) flags.push("-x", String(cols), "-y", String(rows));
  flags.push("-c", shellQuote(options.cwd), options.command);
  const commands = [...setup];
  if (options.fixedSize) {
    // tmux 3.5/3.5a on Linux can ignore `new-session -d -x/-y` while another
    // client is attached, sizing the new pane from that client instead. Seed
    // the server default as well as passing -x/-y, then force manual size for
    // later attaches.
    commands.push(`set-option -g default-size ${cols}x${rows}`);
  }
  commands.push(flags.join(" "));
  if (options.fixedSize) {
    commands.push(`set-option -t ${target} window-size manual`);
    commands.push(`resize-window -t ${target} -x ${cols} -y ${rows}`);
  }
  if (options.remainOnExit) commands.push(`set-window-option -t ${target} remain-on-exit on`);
  if (options.remainOnExit) commands.push(`set-window-option -t ${target} remain-on-exit-format ''`);
  commands.push(`set-option -t ${target} status ${options.status === true ? "on" : "off"}`);
  if (options.historyLimit) commands.push(`set-option -t ${target} history-limit ${options.historyLimit}`);
  return `${observableTerminalEnvPrefix()} tmux ${commands.join(" \\; ")}`;
}

export function buildCapturePaneCommand(options: { session: string; historyLimit?: number; ansi?: boolean; joinWrapped?: boolean }): string {
  const flags = ["capture-pane", "-p"];
  if (options.ansi !== false) flags.push("-e");
  if (options.joinWrapped !== false) flags.push("-J");
  flags.push("-S", `-${options.historyLimit ?? observableTerminalHistoryLimit}`, "-t", shellQuote(options.session));
  return `tmux ${flags.join(" ")} 2>/dev/null || true`;
}

export function buildSetRemainOnExitCommand(): string {
  return "tmux set-window-option remain-on-exit on; tmux set-window-option remain-on-exit-format ''";
}

export function buildListSessionsCommand(): string {
  return "tmux list-sessions -F '#S'";
}

export function buildKillSessionCommand(session: string): string {
  return `tmux kill-session -t ${shellQuote(session)} 2>/dev/null || true`;
}

export function buildHasSessionCommand(session: string): string {
  return `tmux has-session -t ${shellQuote(session)} 2>/dev/null`;
}

export function buildSendInterruptCommand(session: string): string {
  return `tmux send-keys -t ${shellQuote(session)} C-c 2>/dev/null; true`;
}
