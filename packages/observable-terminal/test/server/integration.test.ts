import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote, withCommandSignal } from "@atelier/core";
import {
  attachHostObservableTerminal,
  buildCapturePaneCommand,
  buildKillSessionCommand,
  buildObservableSessionCommand,
  normalizeCarriageReturns,
  observableTerminalCols,
  observableTerminalRows,
  runHostObservableCommand,
} from "../../src/server/index.ts";

const runIntegration = process.env.ATELIER_OBSERVABLE_TERMINAL_INTEGRATION === "1";
const maybe = runIntegration ? describe : describe.skip;
const sessions: string[] = [];

async function sh(command: string): Promise<string> {
  const result = await $`sh -lc ${command}`.quiet();
  return result.stdout.toString();
}

maybe("observable terminal integration", () => {
  afterEach(async () => {
    for (const session of sessions.splice(0)) await sh(buildKillSessionCommand(session)).catch(() => undefined);
  });

  test("fixed-size sessions keep carriage-return progress readable", async () => {
    const session = `atelier-observable-test-${Date.now()}`;
    sessions.push(session);
    const fixture = `import sys, time\nprint("Cloning into 'repo'...")\nfor i in range(1, 101):\n    sys.stderr.write(f"remote: Counting objects: {i:3}% ({i}/100)\\r")\n    sys.stderr.flush()\n    time.sleep(0.005)\nsys.stderr.write("remote: Counting objects: 100% (100/100), done.\\n")`;
    await sh(buildObservableSessionCommand({ session, cwd: process.cwd(), command: `python3 -c ${shellQuote(fixture)}`, fixedSize: true, remainOnExit: true }));
    await sh(`for i in $(seq 1 200); do tmux capture-pane -p -t ${session} | grep -q '100% (100/100)' && exit 0; sleep 0.025; done; exit 1`);
    const screen = await sh(buildCapturePaneCommand({ session }));
    const normalized = normalizeCarriageReturns(screen);

    expect(normalized).toContain("Cloning into 'repo'...");
    expect(normalized).toMatch(/remote: Counting objects:\s+100%/);
    expect(normalized).not.toMatch(/Counting objects:.*Counting objects:/);
    expect(normalized).not.toMatch(/\(1\/100\).*remote: Counting objects:/);
  });

  test("fixed-size sessions report stable dimensions", async () => {
    const session = `atelier-observable-test-${Date.now()}`;
    sessions.push(session);
    await sh(buildObservableSessionCommand({ session, cwd: process.cwd(), command: "sleep 5", fixedSize: true, remainOnExit: true }));
    const size = (await sh(`tmux display-message -p -t ${session} '#{pane_width}x#{pane_height}'`)).trim();
    expect(size).toBe(`${observableTerminalCols}x${observableTerminalRows}`);
  });

  test("host readonly attach works when parent TERM is dumb", async () => {
    const originalTerm = process.env.TERM;
    const session = `atelier-observable-test-${Date.now()}`;
    sessions.push(session);
    process.env.TERM = "dumb";
    try {
      const result = await runHostObservableCommand({
        session,
        cwd: process.cwd(),
        command: "printf 'docker build progress\\n'; sleep 1",
        onSessionStarted: () => new Promise<void>((resolve, reject) => {
          const decoder = new TextDecoder();
          let output = "";
          const timer = setTimeout(() => reject(new Error(output || "timed out waiting for attach output")), 3_000);
          attachHostObservableTerminal({ session, cols: observableTerminalCols, rows: observableTerminalRows, readonly: true, fixedSize: true }, {
            onData: (chunk) => {
              output += decoder.decode(chunk, { stream: true });
              if (output.includes("docker build progress")) {
                clearTimeout(timer);
                resolve();
              }
            },
            onExit: (exitCode) => {
              if (!output.includes("docker build progress")) {
                clearTimeout(timer);
                reject(new Error(`${output || "attach exited before output"} (exit ${exitCode})`));
              }
            },
          });
        }),
      });
      expect(result.exitCode).toBe(0);
    } finally {
      if (originalTerm === undefined) delete process.env.TERM;
      else process.env.TERM = originalTerm;
    }
  });
});

maybe("observable command cancellation", () => {
  test("cancellation stops the command group rather than just the terminal viewer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "observable-cancel-"));
    const controller = new AbortController();
    const session = `atelier-observable-cancel-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const pending = withCommandSignal(controller.signal, () => runHostObservableCommand({
        session, cwd: directory,
        command: "touch started; (sleep 1; touch late) & wait",
      })).catch((error: Error) => error);
      while (!(await Bun.file(join(directory, "started")).exists())) await Bun.sleep(5);
      controller.abort(new Error("cancelled"));
      expect(await pending).toMatchObject({ message: "cancelled" });
      await Bun.sleep(1200);
      expect(await Bun.file(join(directory, "late")).exists()).toBe(false);
    } finally {
      controller.abort();
      await sh(buildKillSessionCommand(session));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
