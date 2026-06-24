import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shellQuote } from "@atelier/core";
import { observableTerminalCols, observableTerminalEnvironment, observableTerminalHistoryLimit, observableTerminalRows } from "./constants.ts";
import { buildKillSessionCommand, buildObservableSessionCommand, buildSetRemainOnExitCommand } from "./tmux.ts";

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
