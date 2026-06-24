import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import { createWorkspace, execWorkspaceCommand, type WorkspaceExecResult } from "@atelier/workspace";
import { cleanupNamespace, createTestNamespace } from "../../../workspace/test/helpers.ts";
import { registerTerminalEvents } from "../../src/server/events.ts";

setDefaultTimeout(30_000);

const testNamespace = createTestNamespace("test-terminal");

beforeAll(async () => {
  process.env.ATELIER_NAMESPACE = testNamespace;
  await cleanupNamespace(testNamespace);
});

afterAll(async () => {
  await cleanupNamespace(testNamespace);
});

describe("terminal workspace events", () => {
  test("workspace_created starts a default tmux terminal session", async () => {
    const events = createAtelierEventBus();
    registerTerminalEvents(events);

    const created = await createWorkspace({ events });
    await events.emit("workspace_created", { workspaceId: created.id });

    const exec = await execWorkspaceCommand(created.id, ["tmux", "list-sessions", "-F", "#S"]) as WorkspaceExecResult;
    expect(exec.exitCode).toBe(0);
    expect(exec.stdout.trim().split(/\n+/)).toEqual(["Terminal 1"]);
  });
});
