import { spawn, type IPty } from "@zenyr/bun-pty";
import { observableTerminalEnvironment } from "./constants.ts";

export { type IPty } from "@zenyr/bun-pty";

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

function tmuxAttachArgs(options: { session: string; cols: number; rows: number; readonly?: boolean; fixedSize?: boolean }): string[] {
  const args: string[] = [];
  if (options.fixedSize) {
    args.push("set-option", "-t", options.session, "window-size", "manual", ";", "resize-window", "-t", options.session, "-x", String(options.cols), "-y", String(options.rows), ";");
  }
  args.push("attach-session");
  if (options.readonly) args.push("-r");
  args.push("-t", options.session);
  return args;
}

export function buildAttachArgs(options: ObservableTerminalAttachOptions): string[] {
  const env = { ...observableTerminalEnvironment, ...options.env };
  const args = ["exec", "-it", "--user", options.user ?? "atelier"];
  if (options.workdir) args.push("--workdir", options.workdir);
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  args.push(options.containerName, "tmux", ...tmuxAttachArgs(options));
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
  return tmuxAttachArgs(options);
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
