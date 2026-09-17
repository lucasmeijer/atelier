import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as agent from "@atelier/agent/server";
import { createTestApp, deferred, postJson, temporaryAtelierDataDir } from "./support/test-web-app.ts";

const data = temporaryAtelierDataDir();
beforeEach(data.setUp);
afterEach(data.tearDown);

describe("launch title generation", () => {
  test("names from the launch prompt after provisioning without an Agent conversation", async () => {
    const prepare = spyOn(agent, "prepareNewWorkspaceAgentParameters").mockImplementation(async (parameters) => parameters);
    const name = spyOn(agent, "maybeNameWorkspaceFromPrompt").mockImplementation(() => {});
    try {
      const ready = deferred();
      const { app, registry } = createTestApp({ provision: () => ready.promise });
      const response = await app.fetch(postJson("/workspaces", {
        agent: { initialPrompt: "Build a calendar", model: "provider::model" },
      }));
      expect(response.status).toBe(202);
      const { workspace } = await response.json();
      expect(name).not.toHaveBeenCalled();
      ready.resolve();
      await Bun.sleep(0);
      expect(registry.get(workspace.id)?.phase).toBe("ready");
      expect(name).toHaveBeenCalledTimes(1);
      expect(name).toHaveBeenCalledWith(workspace.id, "Build a calendar", {
        events: undefined, agentModel: { provider: "provider", id: "model" },
      });
    } finally {
      prepare.mockRestore();
      name.mockRestore();
    }
  });

  test("a promptless launch leaves naming to later message submission", async () => {
    const name = spyOn(agent, "maybeNameWorkspaceFromPrompt").mockImplementation(() => {});
    try {
      const { app } = createTestApp();
      expect((await app.fetch(postJson("/workspaces", {}))).status).toBe(202);
      await Bun.sleep(0);
      expect(name).not.toHaveBeenCalled();
    } finally {
      name.mockRestore();
    }
  });

  test("failed provisioning does not request a title", async () => {
    const prepare = spyOn(agent, "prepareNewWorkspaceAgentParameters").mockImplementation(async (parameters) => parameters);
    const name = spyOn(agent, "maybeNameWorkspaceFromPrompt").mockImplementation(() => {});
    try {
      const { app } = createTestApp({ provision: async () => { throw new Error("provision failed"); } });
      expect((await app.fetch(postJson("/workspaces", { agent: { initialPrompt: "Build a calendar" } }))).status).toBe(202);
      await Bun.sleep(0);
      expect(name).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      name.mockRestore();
    }
  });
});
