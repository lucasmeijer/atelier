import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shellQuote, commandSignal, runCommand, killCommandGroup, withCommandSignal } from "@atelier/core";
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
  const signal = commandSignal();
  signal?.throwIfAborted();
  const cols = options.cols ?? observableTerminalCols;
  const rows = options.rows ?? observableTerminalRows;
  const runId = crypto.randomUUID().slice(0, 12);
  const exitFile = join(tmpdir(), `${options.session}-${runId}.exit`);
  const pidFile = `${exitFile}.pid`;
  const colorEnv = `TERM=xterm-256color COLORTERM=truecolor COLUMNS=${cols} LINES=${rows} CLICOLOR_FORCE=1 FORCE_COLOR=1 COLOR=1`;
  const forceTtySize = `stty cols ${cols} rows ${rows} 2>/dev/null || true`;
  const inner = `${buildSetRemainOnExitCommand()}; ${forceTtySize}; ${colorEnv} ${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dir, "host-command-process.ts"))} ${shellQuote(`echo $$ > ${shellQuote(pidFile)}; if test -f ${shellQuote(`${pidFile}.cancel`)}; then exit 125; fi; ${forceTtySize}; ${options.command}`)}; echo $? > ${shellQuote(exitFile)}`;
  let completed = false;
  try {
    const create = await runCommand(["sh", "-lc", buildObservableSessionCommand({
      session: options.session,
      cwd: options.cwd,
      command: shellQuote(inner),
      cols,
      rows,
      fixedSize: true,
      remainOnExit: true,
      historyLimit: observableTerminalHistoryLimit,
      env: options.env,
    })], { env: { ...process.env, ...observableTerminalEnvironment, ...options.env } });
    const { stdout, stderr, exitCode: createExit } = create;
    if (createExit !== 0) throw new Error((stderr || stdout.toString()).trim() || `could not start terminal session ${options.session}`);
    await options.onSessionStarted?.(options.session);

    let exitCode: number | undefined;
    while (exitCode === undefined) {
      signal?.throwIfAborted();
      const text = await readFile(exitFile, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      if (text.trim()) exitCode = Number(text.trim());
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const captured = Bun.spawnSync(["tmux", "capture-pane", "-p", "-e", "-J", "-S", `-${observableTerminalHistoryLimit}`, "-t", options.session], { stdout: "pipe", stderr: "ignore" });
    const output = captured.stdout.toString();
    const cleanupAfterMs = options.cleanupAfterMs ?? 5 * 60_000;
    if (cleanupAfterMs >= 0) setTimeout(() => { Bun.spawn(["sh", "-lc", buildKillSessionCommand(options.session)]); }, cleanupAfterMs).unref?.();
    completed = true;
    return { exitCode, output };
  } finally {
    if (!completed) {
      await withCommandSignal(AbortSignal.timeout(10_000), async () => {
        await writeFile(`${pidFile}.cancel`, "");
        const pid = await readFile(pidFile, "utf8").catch((error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        if (pid.trim()) killCommandGroup(Number(pid.trim()));
        const stopped = await runCommand(["sh", "-lc", buildKillSessionCommand(options.session)]);
        if (stopped.exitCode !== 0) throw new Error(stopped.stderr);
      });
    }
    await rm(pidFile, { force: true });
    await rm(exitFile, { force: true });
  }
}
