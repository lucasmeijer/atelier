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
