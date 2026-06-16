import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  buildCapturePaneCommand,
  buildKillSessionCommand,
  buildObservableSessionCommand,
  normalizeCarriageReturns,
  observableTerminalCols,
  observableTerminalRows,
  shellQuote,
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
});
