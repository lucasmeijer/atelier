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
  const target = shellQuote(options.session);
  const flags = ["new-session", "-d", "-s", target];
  for (const [key, value] of Object.entries({ ...observableTerminalEnvironment, ...options.env })) {
    if (value !== undefined) flags.push("-e", shellQuote(`${key}=${String(value)}`));
  }
  if (options.fixedSize) flags.push("-x", String(cols), "-y", String(rows));
  flags.push("-c", shellQuote(options.cwd), options.command);
  const commands = [flags.join(" ")];
  if (options.passthrough) commands.push(`set-option -t ${target} allow-passthrough on`);
  if (options.fixedSize) {
    commands.push(`set-option -t ${target} window-size manual`);
    commands.push(`resize-window -t ${target} -x ${cols} -y ${rows}`);
  }
  if (options.remainOnExit) {
    commands.push(`set-window-option -t ${target} remain-on-exit on`);
    commands.push(`set-window-option -t ${target} remain-on-exit-format ''`);
  }
  commands.push(`set-option -t ${target} status ${options.status === true ? "on" : "off"}`);
  if (options.historyLimit) commands.push(`set-option -t ${target} history-limit ${options.historyLimit}`);
  return `${observableTerminalEnvPrefix()} tmux ${commands.join(" \\; ")}`;
}

/** Configure tmux-owned history to behave like natural terminal scrollback. */
export function buildNaturalScrollCommand(): string {
  return [
    "tmux set-option -g mouse on",
    "tmux bind-key -n S-PPage copy-mode -e '\\;' send-keys -X page-up",
    "tmux bind-key -T copy-mode S-PPage send-keys -X page-up",
    "tmux bind-key -T copy-mode S-NPage send-keys -X page-down",
  ].join(" && ");
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

export function buildListSessionsCommand(format = "#S"): string {
  return `tmux list-sessions -F ${shellQuote(format)}`;
}

export function buildKillSessionCommand(session: string): string {
  return `tmux kill-session -t ${shellQuote(session)} 2>/dev/null || true`;
}

export function buildSendInterruptCommand(session: string): string {
  return `tmux send-keys -t ${shellQuote(session)} C-c 2>/dev/null; true`;
}
