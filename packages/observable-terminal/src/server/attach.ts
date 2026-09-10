import { observableTerminalEnvironment } from "./constants.ts";

const terminalBridgeSource = String.raw`
// Runs under Bun inside the workspace. Docker transports pipes, not a PTY:
// stdin is newline-delimited input/resize commands; stdout is raw PTY output.
// Owning the PTY here makes stdin EOF detach tmux even if Atelier disappears.
import { createInterface } from "node:readline";
const { args, cols, rows } = JSON.parse(process.argv[1]);
const terminal = new Bun.Terminal({
  name: "xterm-256color",
  cols,
  rows,
  data: (_terminal, data) => process.stdout.write(data),
});
const child = Bun.spawn(["tmux", ...args], { terminal });
let closed = false;
function close() {
  if (closed) return;
  closed = true;
  // Hang up this client, never the tmux server or the program in its pane.
  child.kill("SIGHUP");
  terminal.close();
}
process.on("SIGTERM", close);
process.on("SIGHUP", close);
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (closed) return;
  const message = JSON.parse(line);
  if (message.type === "input") terminal.write(message.data);
  else if (message.type === "resize") {
    terminal.resize(message.cols, message.rows);
    child.kill("SIGWINCH");
  } else throw new Error("Unknown terminal bridge message: " + message.type);
});
input.on("close", close);
void child.exited.then((exitCode) => {
  if (!closed) terminal.close();
  closed = true;
  input.close();
  process.stdin.destroy();
  process.exitCode = exitCode;
});
`;

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
  const args = ["exec", "-i", "--user", options.user ?? "atelier"];
  if (options.workdir) args.push("--workdir", options.workdir);
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  args.push(options.containerName, "bun", "-e", terminalBridgeSource, JSON.stringify({
    args: tmuxAttachArgs(options), cols: options.cols, rows: options.rows,
  }));
  return args;
}

export function attachHostObservableTerminal(options: HostObservableTerminalAttachOptions, events: ObservableTerminalEvents): ObservableTerminalConnection {
  const env = { ...process.env, ...observableTerminalEnvironment, ...options.env, TMUX: undefined, TMUX_PANE: undefined };
  const terminal = new Bun.Terminal({
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    data: (_terminal, data) => events.onData(data),
  });
  const subprocess = Bun.spawn({ cmd: ["tmux", ...tmuxAttachArgs(options)], env, terminal });

  let closed = false;
  void subprocess.exited.then((exitCode) => {
    if (!closed) terminal.close();
    closed = true;
    events.onExit(exitCode);
  });

  return {
    write: (data) => { if (!closed) terminal.write(data); },
    resize: (cols, rows) => {
      if (closed) return;
      terminal.resize(cols, rows);
      // Bun's PTY resize updates dimensions without notifying the client.
      subprocess.kill("SIGWINCH");
    },
    close: () => {
      if (closed) return;
      closed = true;
      subprocess.kill("SIGHUP");
      terminal.close();
    },
  };
}

export function attachObservableTerminal(options: ObservableTerminalAttachOptions, events: ObservableTerminalEvents): ObservableTerminalConnection {
  // Killing `docker exec -t` leaves its remote PTY and tmux client alive.
  // Instead, the workspace bridge owns that PTY and hangs it up on stdin EOF.
  const subprocess = Bun.spawn(["docker", ...buildAttachArgs(options)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let closed = false;
  const output = (async () => {
    for await (const chunk of subprocess.stdout) events.onData(chunk);
  })();
  const errors = new Response(subprocess.stderr).text();
  void (async () => {
    const [exitCode, stderr] = await Promise.all([subprocess.exited, errors, output]);
    if (exitCode !== 0 && !closed && stderr) {
      events.onData(new TextEncoder().encode(`\r\n${stderr.replace(/\r?\n/g, "\r\n")}`));
    }
    closed = true;
    events.onExit(exitCode);
  })();
  const send = (message: { type: "input"; data: string } | { type: "resize"; cols: number; rows: number }): void => {
    if (!closed) subprocess.stdin.write(`${JSON.stringify(message)}\n`);
  };
  return {
    write: (data) => send({ type: "input", data }),
    resize: (cols, rows) => send({ type: "resize", cols, rows }),
    close: () => {
      if (closed) return;
      closed = true;
      subprocess.stdin.end();
    },
  };
}
