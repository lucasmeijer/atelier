import { expect, test } from "bun:test";
import { join } from "node:path";

// Isolate catalogue mocks from the real provider registry used by the web tests.
async function scenario(script: string) {
  const child = Bun.spawn([process.execPath, "-e", `
    import { expect, mock } from "bun:test";
    const llm = await import("@atelier/llm/server");
    const favorites = [
      { provider: "openai-codex", id: "codex", label: "Codex" },
      { provider: "anthropic", id: "first", label: "First" },
      { provider: "anthropic", id: "second", label: "Second" },
      { provider: "anthropic", id: "unavailable", label: "Unavailable" },
    ];
    mock.module("@atelier/llm/server", () => ({ ...llm,
      getConfiguredModels: async () => favorites,
      createPiModelRuntime: async () => ({ getAvailable: async () => favorites.slice(0, 3), getProviderAuthStatus: () => ({ configured: true }), getModel: () => ({ thinkingLevelMap: { minimal: "low", off: null, xhigh: "max" } }) }),
      modelThinkingLevels: async () => ["off", "minimal", "low", "medium", "high", "xhigh"],
    }));
    const { claudeModelSettings: { prepare } } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/model-settings.ts"))});
    ${script}
  `], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
}

test("defaults to the first available Claude favorite, never another provider", () => scenario(`
  expect(await prepare()).toEqual({ model: "anthropic::first", thinkingLevel: "medium" });
`));

test("accepts a chosen Claude favorite and supported thinking level", () => scenario(`
  expect(await prepare({ model: "anthropic::second", thinkingLevel: "high" })).toEqual({ model: "anthropic::second", thinkingLevel: "high" });
  expect((await prepare({ thinkingLevel: "max" })).thinkingLevel).toBe("max");
`));

test("rejects foreign, unavailable, non-favorite models and invalid thinking levels", () => scenario(`
  for (const model of ["openai-codex::codex", "anthropic::unavailable", "anthropic::not-favorite", 42]) {
    await expect(prepare({ model })).rejects.toMatchObject({ code: "invalid_arguments" });
  }
  await expect(prepare({ thinkingLevel: "invented" })).rejects.toMatchObject({ code: "invalid_arguments" });
`));

test("offers native Claude efforts rather than Pi aliases", () => scenario(`
  expect((await prepare({ thinkingLevel: "low" })).thinkingLevel).toBe("low");
  for (const thinkingLevel of ["minimal", "off", "none", "xhigh"]) {
    await expect(prepare({ thinkingLevel })).rejects.toMatchObject({ code: "invalid_arguments" });
  }
`));
