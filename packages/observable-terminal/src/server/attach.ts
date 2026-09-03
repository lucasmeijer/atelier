import { observableTerminalEnvironment } from "./constants.ts";

export interface ObservableTerminalConnection {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface ObservableTerminalEvents {
  onData(data: Uint8Array): void;
  onExit(exitCode: number): void;
}

export interface HostObservableTerminalAttachOptions {
  session: string;
  cols: number;
  rows: number;
  readonly?: boolean;
  fixedSize?: boolean;
  env?: Record<string, string>;
}

export interface ObservableTerminalAttachOptions extends HostObservableTerminalAttachOptions {
  containerName: string;
  user?: string;
  workdir?: string;
}

function tmuxAttachArgs(options: HostObservableTerminalAttachOptions): string[] {
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

function spawnTerminal(
  command: string,
  args: string[],
  options: { cols: number; rows: number; env: Record<string, string | undefined> },
  events: ObservableTerminalEvents,
): ObservableTerminalConnection {
  const terminal = new Bun.Terminal({
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    data: (_terminal, data) => events.onData(data),
  });
  const subprocess = Bun.spawn({ cmd: [command, ...args], env: options.env, terminal });

  void subprocess.exited.then((exitCode) => {
    terminal.close();
    events.onExit(exitCode);
  });

  return {
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    close: () => subprocess.kill(),
  };
}

export function attachObservableTerminal(options: ObservableTerminalAttachOptions, events: ObservableTerminalEvents): ObservableTerminalConnection {
  return spawnTerminal("docker", buildAttachArgs(options), {
    cols: options.cols,
    rows: options.rows,
    env: { ...process.env, ...observableTerminalEnvironment, ...options.env },
  }, events);
}

export function buildHostAttachArgs(options: HostObservableTerminalAttachOptions): string[] {
  return tmuxAttachArgs(options);
}

export function attachHostObservableTerminal(options: HostObservableTerminalAttachOptions, events: ObservableTerminalEvents): ObservableTerminalConnection {
  const env = { ...process.env, ...observableTerminalEnvironment, ...options.env, TMUX: undefined, TMUX_PANE: undefined };
  return spawnTerminal("tmux", buildHostAttachArgs(options), {
    cols: options.cols,
    rows: options.rows,
    env,
  }, events);
}
