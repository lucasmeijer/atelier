import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type IPty } from "@zenyr/bun-pty";
import { shellQuote } from "@atelier/core";

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

export interface HostObservableTerminalAttachOptions {
  session: string;
  cols: number;
  rows: number;
  readonly?: boolean;
  fixedSize?: boolean;
  env?: Record<string, string>;
}

export interface HostObservableCommandOptions {
  session: string;
  cwd: string;
  command: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  onSessionStarted?: (session: string) => void | Promise<void>;
  cleanupAfterMs?: number;
}

export interface HostObservableCommandResult {
  exitCode: number;
  output: string;
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

export function buildHostAttachArgs(options: HostObservableTerminalAttachOptions): string[] {
  const args: string[] = [];
  if (options.fixedSize) {
    args.push("set-option", "-t", options.session, "window-size", "manual", ";", "resize-window", "-t", options.session, "-x", String(options.cols), "-y", String(options.rows), ";");
  }
  args.push("attach-session");
  if (options.readonly) args.push("-r");
  args.push("-t", options.session);
  return args;
}

export function attachHostObservableTerminal(options: HostObservableTerminalAttachOptions): IPty {
  const env = { ...observableTerminalEnvironment, ...options.env };
  return spawn("env", [...Object.entries(env).map(([key, value]) => `${key}=${value}`), "tmux", ...buildHostAttachArgs(options)], {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    env: { ...process.env, ...env },
  });
}

export async function runHostObservableCommand(options: HostObservableCommandOptions): Promise<HostObservableCommandResult> {
  const cols = options.cols ?? observableTerminalCols;
  const rows = options.rows ?? observableTerminalRows;
  const runId = crypto.randomUUID().slice(0, 12);
  const exitFile = join(tmpdir(), `${options.session}-${runId}.exit`);
  const colorEnv = `TERM=xterm-256color COLORTERM=truecolor COLUMNS=${cols} LINES=${rows} CLICOLOR_FORCE=1 FORCE_COLOR=1 COLOR=1`;
  const forceTtySize = `stty cols ${cols} rows ${rows} 2>/dev/null || true`;
  const inner = `${buildSetRemainOnExitCommand()}; ${forceTtySize}; ${colorEnv} bash -lc ${shellQuote(`${forceTtySize}; ${options.command}`)}; echo $? > ${shellQuote(exitFile)}`;
  const create = Bun.spawn(["sh", "-lc", buildObservableSessionCommand({
    session: options.session,
    cwd: options.cwd,
    command: shellQuote(inner),
    cols,
    rows,
    fixedSize: true,
    remainOnExit: true,
    historyLimit: observableTerminalHistoryLimit,
    env: options.env,
  })], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...observableTerminalEnvironment, ...options.env } });
  const [stdout, stderr, createExit] = await Promise.all([new Response(create.stdout).text(), new Response(create.stderr).text(), create.exited]);
  if (createExit !== 0) throw new Error((stderr || stdout).trim() || `could not start terminal session ${options.session}`);
  await options.onSessionStarted?.(options.session);

  let exitCode: number | undefined;
  while (exitCode === undefined) {
    const text = await readFile(exitFile, "utf8").catch(() => "");
    if (text.trim()) exitCode = Number(text.trim());
    else await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const captured = Bun.spawnSync(["tmux", "capture-pane", "-p", "-e", "-J", "-S", `-${observableTerminalHistoryLimit}`, "-t", options.session], { stdout: "pipe", stderr: "ignore" });
  const output = captured.stdout.toString();
  await rm(exitFile, { force: true }).catch(() => undefined);
  const cleanupAfterMs = options.cleanupAfterMs ?? 5 * 60_000;
  if (cleanupAfterMs >= 0) setTimeout(() => { Bun.spawn(["sh", "-lc", buildKillSessionCommand(options.session)]); }, cleanupAfterMs).unref?.();
  return { exitCode, output };
}
