import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import { createWorkspace } from "@atelier/workspace";
import { cleanupNamespace, createTestNamespace } from "../../../workspace/test/helpers.ts";
import { registerTerminalEvents } from "../../src/server/events.ts";
import { listWorkspaceTerminals } from "../../src/server/workspace-terminals.ts";

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
  test("workspace_created does not start a default terminal session", async () => {
    const events = createAtelierEventBus();
    registerTerminalEvents(events);

    const created = await createWorkspace({ events });
    await events.emit("workspace_created", { workspaceId: created.id });

    expect((await listWorkspaceTerminals(created.id)).terminals).toEqual([]);
  });
});
