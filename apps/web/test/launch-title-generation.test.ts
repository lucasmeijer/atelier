import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as agent from "@atelier/agent/server";
import { atelierServerModule as codexModule } from "@atelier/codex-agent/server";
import { createTestApp, deferred, postJson, temporaryAtelierDataDir } from "./support/test-web-app.ts";

const data = temporaryAtelierDataDir();
beforeEach(data.setUp);
afterEach(data.tearDown);

describe("launch title generation", () => {
  test.each([
    { provider: "builtin", launch: agent.nativeAgentLaunch, model: "provider::model" },
    { provider: "codex", launch: codexModule.agentProvider!.launch, model: "openai-codex::gpt-5.4" },
  ])("names $provider from the launch prompt after provisioning without an Agent conversation", async ({ provider, launch, model }) => {
    const prepare = spyOn(launch, "prepare").mockImplementation(async (parameters) => ({ agent: { initialPrompt: String(parameters?.initialPrompt ?? ""), model: String(parameters?.model ?? "") } }));
    const name = spyOn(agent, "maybeNameWorkspaceFromPrompt").mockImplementation(() => {});
    try {
      const ready = deferred();
      const { app, registry } = createTestApp({ provision: () => ready.promise });
      const response = await app.fetch(postJson("/workspaces", {
        agent: { provider, initialPrompt: "Build a calendar", model },
      }));
      expect(response.status).toBe(202);
      const { workspace } = await response.json();
      expect(name).not.toHaveBeenCalled();
      ready.resolve();
      await Bun.sleep(0);
      expect(registry.get(workspace.id)?.phase).toBe("ready");
      expect(name).toHaveBeenCalledTimes(1);
      expect(name).toHaveBeenCalledWith(workspace.id, "Build a calendar", {
        events: undefined, agentModel: { provider: model.split("::")[0], id: model.split("::")[1] },
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
    const prepare = spyOn(agent.nativeAgentLaunch, "prepare").mockImplementation(async (parameters) => ({ agent: { initialPrompt: String(parameters?.initialPrompt ?? ""), model: String(parameters?.model ?? "") } }));
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
