import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createWorkspace, execWorkspaceShell } from "@atelier/workspace";
import { cleanupNamespace, createTestNamespace } from "../../../workspace/test/helpers.ts";
import { attachWorkspaceTerminal, createWorkspaceTerminal, deleteWorkspaceTerminal, listTmuxSessions, listWorkspaceTerminals } from "../../src/server/workspace-terminals.ts";

setDefaultTimeout(30_000);

const testNamespace = createTestNamespace("test-terminal");

beforeAll(async () => {
  process.env.ATELIER_NAMESPACE = testNamespace;
  await cleanupNamespace(testNamespace);
});

afterAll(async () => {
  await cleanupNamespace(testNamespace);
});

describe("workspace terminals", () => {
  test("does not turn tmux sessions into Terminal views", async () => {
    const workspace = await createWorkspace();
    await execWorkspaceShell(workspace.id, "tmux new-session -d -s existing-session");

    expect(await listWorkspaceTerminals(workspace.id)).toEqual([]);

    const attached = await attachWorkspaceTerminal(workspace.id, "existing-session");
    expect(attached.tmuxSession).toBe("existing-session");
    expect(attached.sessionRelationship).toBe("attached");
    expect(await listWorkspaceTerminals(workspace.id)).toEqual([attached]);

    await deleteWorkspaceTerminal(workspace.id, attached.id);
    expect(await listWorkspaceTerminals(workspace.id)).toEqual([]);
    expect((await listTmuxSessions(workspace.id)).some((session) => session.name === "existing-session")).toBe(true);
  });

  test("creates and persists a new terminal and tmux session", async () => {
    const workspace = await createWorkspace();
    const terminal = await createWorkspaceTerminal(workspace.id);

    expect(terminal.title).toBe("Terminal 1");
    expect(terminal.tmuxSession).toBe("Terminal 1");
    expect(terminal.sessionRelationship).toBe("owned");
    expect(await listWorkspaceTerminals(workspace.id)).toEqual([terminal]);
    expect((await listTmuxSessions(workspace.id)).some((session) => session.name === terminal.tmuxSession)).toBe(true);

    await deleteWorkspaceTerminal(workspace.id, terminal.id);

    expect(await listWorkspaceTerminals(workspace.id)).toEqual([]);
    expect((await listTmuxSessions(workspace.id)).some((session) => session.name === terminal.tmuxSession)).toBe(false);
  });
});
