import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestApp, postJson, temporaryAtelierDataDir } from "./support/test-web-app.ts";
import { defaultAgentProvider } from "../src/server/agent-providers.ts";

const data = temporaryAtelierDataDir();
beforeEach(data.setUp);
afterEach(data.tearDown);

test("Codex workspace creation requires its subscription before provisioning", async () => {
  let provisioned = false;
  const { app, registry } = createTestApp({ provision: async () => { provisioned = true; } });
  const response = await app.fetch(postJson("/workspaces", { agent: { provider: "codex", initialPrompt: "Do not run without authentication" } }));
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatchObject({ code: "agent_setup_required", setupUrl: "/settings/models/step?provider=openai-codex" });
  expect(provisioned).toBe(false);
  expect(registry.list()).toHaveLength(0);
  expect((await defaultAgentProvider()).id).toBe("builtin");
});

test("adding a Codex tab requires authentication without changing the default", async () => {
  const { app, registry } = createTestApp();
  await registry.seed([{ id: "codex-auth-test", title: "Codex auth" }]);
  const response = await app.fetch(postJson("/workspaces/codex-auth-test/commands/agent.create.codex", {}));
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("agent_setup_required");
  expect((await defaultAgentProvider()).id).toBe("builtin");
});
