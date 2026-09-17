import { expect, test } from "bun:test";
import { join } from "node:path";

test("requires an Anthropic subscription, not an API key or another provider's OAuth", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
    import { expect, mock } from "bun:test";
    const llm = await import("@atelier/llm/server");
    let credentials = [];
    mock.module("@atelier/llm/server", () => ({ ...llm, createPiModelRuntime: async () => ({ listCredentials: async () => credentials }) }));
    const { requireClaudeSubscription, claudeSubscriptionSetupUrl } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/auth.ts"))});
    expect(claudeSubscriptionSetupUrl).toBe("/settings/models/step?provider=anthropic");
    for (const entries of [[], [{ providerId: "anthropic", type: "api_key" }], [{ providerId: "openai-codex", type: "oauth" }]]) {
      credentials = entries;
      await expect(requireClaudeSubscription()).rejects.toMatchObject({ code: "agent_setup_required" });
    }
    credentials = [{ providerId: "anthropic", type: "oauth" }];
    await requireClaudeSubscription();
  `], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
