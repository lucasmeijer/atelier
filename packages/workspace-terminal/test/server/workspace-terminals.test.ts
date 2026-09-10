import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createWorkspace, execWorkspaceShell } from "@atelier/workspace";
import { cleanupNamespace, createTestNamespace } from "../../../workspace/test/helpers.ts";
import { attachWorkspaceTerminal, createWorkspaceTerminal, deleteWorkspaceTerminal, listTmuxSessions, listWorkspaceTerminals } from "../../src/server/workspace-terminals.ts";

setDefaultTimeout(30_000);

const testNamespace = createTestNamespace("test-terminal");
let workspaceId: string;

beforeAll(async () => {
  process.env.ATELIER_NAMESPACE = testNamespace;
  await cleanupNamespace(testNamespace);
  workspaceId = (await createWorkspace()).id;
});

afterAll(async () => {
  await cleanupNamespace(testNamespace);
});

describe("workspace terminals", () => {
  test("does not turn tmux sessions into Terminal views", async () => {
    await execWorkspaceShell(workspaceId, "tmux new-session -d -s existing-session");

    expect(await listWorkspaceTerminals(workspaceId)).toEqual([]);

    const attached = await attachWorkspaceTerminal(workspaceId, "existing-session");
    expect(attached.tmuxSession).toBe("existing-session");
    expect(attached.sessionRelationship).toBe("attached");
    expect(await listWorkspaceTerminals(workspaceId)).toEqual([attached]);

    await deleteWorkspaceTerminal(workspaceId, attached.id);
    expect(await listWorkspaceTerminals(workspaceId)).toEqual([]);
    expect((await listTmuxSessions(workspaceId)).some((session) => session.name === "existing-session")).toBe(true);
  });

  test("creates and persists a new terminal and tmux session", async () => {
    const terminal = await createWorkspaceTerminal(workspaceId);

    expect(terminal.title).toBe("Terminal 1");
    expect(terminal.tmuxSession).toBe("Terminal 1");
    expect(terminal.sessionRelationship).toBe("owned");
    expect(await listWorkspaceTerminals(workspaceId)).toEqual([terminal]);
    expect((await listTmuxSessions(workspaceId)).some((session) => session.name === terminal.tmuxSession)).toBe(true);

    await deleteWorkspaceTerminal(workspaceId, terminal.id);

    expect(await listWorkspaceTerminals(workspaceId)).toEqual([]);
    expect((await listTmuxSessions(workspaceId)).some((session) => session.name === terminal.tmuxSession)).toBe(false);
  });
});

// Server-side installation/command lifecycle checks, not terminal rendering tests.
describe("terminal intro installation", () => {
  test("reuses the native executable across new interactive sessions", async () => {
    const first = await createWorkspaceTerminal(workspaceId);
    const installed = await execWorkspaceShell(workspaceId, "stat -c '%i:%Y' /.atelier/terminal-intro/*");
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout.trim().split("\n")).toHaveLength(1);

    const second = await createWorkspaceTerminal(workspaceId);
    const reused = await execWorkspaceShell(workspaceId, "stat -c '%i:%Y' /.atelier/terminal-intro/*");
    expect(reused.exitCode).toBe(0);
    expect(reused.stdout).toBe(installed.stdout);
    const executable = await execWorkspaceShell(workspaceId, "/.atelier/terminal-intro/* --help");
    expect(executable.exitCode).toBe(0);

    await deleteWorkspaceTerminal(workspaceId, first.id);
    await deleteWorkspaceTerminal(workspaceId, second.id);
  });

  test("explicit commands execute without waiting for a terminal viewer", async () => {
    const marker = `/tmp/terminal-command-${crypto.randomUUID()}`;
    const terminal = await createWorkspaceTerminal(workspaceId, { command: `printf ready > ${marker}` });
    const completed = await execWorkspaceShell(workspaceId, `for attempt in $(seq 1 100); do
  if [ -f ${marker} ]; then cat ${marker}; exit 0; fi
  sleep 0.05
done
exit 1`);
    expect(completed.exitCode).toBe(0);
    expect(completed.stdout).toBe("ready");
    await deleteWorkspaceTerminal(workspaceId, terminal.id);
  });
});
