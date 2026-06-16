import { spawn, type IPty } from "@zenyr/bun-pty";

export { type IPty } from "@zenyr/bun-pty";
export { observableTerminalStaticFiles } from "./static.ts";

export const observableTerminalCols = 120;
export const observableTerminalRows = 30;
export const observableTerminalHistoryLimit = 100_000;
export const observableTerminalEnvironment = {
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
} as const;

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

export interface ObservableTerminalAttachOptions {
  containerName: string;
  session: string;
  cols: number;
  rows: number;
  user?: string;
  workdir?: string;
  readonly?: boolean;
  fixedSize?: boolean;
  env?: Record<string, string>;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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

export function normalizeCarriageReturns(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^.*\r/gm, "");
}

export function stripTerminalControls(text: string): string {
  return normalizeCarriageReturns(text)
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
    .replace(/\u001b[()][0-9A-B]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

export function stripObservablePaneFraming(text: string): string {
  let output = text.replace(/[ \t\r\n]*$/, "");
  for (;;) {
    const lastNewline = Math.max(output.lastIndexOf("\n"), output.lastIndexOf("\r"));
    const line = lastNewline >= 0 ? output.slice(lastNewline + 1) : output;
    const plainLine = stripTerminalControls(line).trim();
    if (!/^Pane is dea(?:d)?$/.test(plainLine)) return output;
    output = lastNewline >= 0 ? output.slice(0, lastNewline) : "";
    output = output.replace(/[ \t\r\n]*$/, "");
  }
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
  const flags = ["new-session", "-d", "-s", shellQuote(options.session)];
  if (options.fixedSize) flags.push("-x", String(cols), "-y", String(rows));
  flags.push("-c", shellQuote(options.cwd), options.command);
  const commands = [...setup, flags.join(" ")];
  if (options.fixedSize) commands.push(`set-option -t ${shellQuote(options.session)} window-size manual`);
  if (options.remainOnExit) commands.push(`set-window-option -t ${shellQuote(options.session)} remain-on-exit on`);
  commands.push(`set-option -t ${shellQuote(options.session)} status ${options.status === true ? "on" : "off"}`);
  if (options.historyLimit) commands.push(`set-option -t ${shellQuote(options.session)} history-limit ${options.historyLimit}`);
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
  return "tmux set-window-option remain-on-exit on";
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

export function buildAttachArgs(options: ObservableTerminalAttachOptions): string[] {
  const env = { ...observableTerminalEnvironment, ...options.env };
  const args = ["exec", "-it", "--user", options.user ?? "atelier"];
  if (options.workdir) args.push("--workdir", options.workdir);
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  args.push(options.containerName, "tmux");
  if (options.fixedSize) {
    args.push("set-option", "-t", options.session, "window-size", "manual", ";", "resize-window", "-t", options.session, "-x", String(options.cols), "-y", String(options.rows), ";");
  }
  args.push("attach-session");
  if (options.readonly) args.push("-r");
  args.push("-t", options.session);
  return args;
}

export function attachObservableTerminal(options: ObservableTerminalAttachOptions): IPty {
  return spawn("docker", buildAttachArgs(options), {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    env: { ...process.env, ...observableTerminalEnvironment, ...options.env },
  });
}
