import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createAtelierEventBus, execWorkspace, workspaceCommand, type WorkspaceExecResult, type WorkspaceNewResult } from "@atelier/core";
import { cleanupNamespace, createTestNamespace } from "../../../core/test/helpers.ts";
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

    const created = await workspaceCommand(["new"], { events }) as WorkspaceNewResult;

    const exec = await execWorkspace(created.id, ["tmux", "list-sessions", "-F", "#S"]) as WorkspaceExecResult;
    expect(exec.exitCode).toBe(0);
    expect(exec.stdout.trim().split(/\n+/)).toEqual(["Terminal 1"]);
  });
});
