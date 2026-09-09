import { expect, test } from "bun:test";
import { delegationPrompt } from "../../src/server/prompt.ts";
import upstream from "../../src/server/codex-prompts.json";

test("Astra medium resolves catalogue roles and explicit delegation for both root and child", () => {
  const root = delegationPrompt("gpt-6-astra", "medium", "root").join("\n");
  const child = delegationPrompt("gpt-6-astra", "medium", "subagent").join("\n");
  expect(root).toContain("You are `/root`, the primary agent");
  expect(child).not.toContain("You are `/root`, the primary agent");
  expect(child).toContain("that content is immediately delivered back to your parent agent");
  for (const prompt of [root, child]) {
    expect(prompt).toContain("Always put proper spaces between words and/or numbers.");
    expect(prompt).toContain(upstream.defaults.explicit);
    expect(prompt).not.toContain("functions.exec");
    expect(prompt).not.toContain("analysis channel");
    expect(prompt).toContain("6 subagents");
    expect(prompt).toContain("does not accept model or reasoning overrides");
  }
});

test("Ultra selects proactive policy, never xhigh or medium", () => {
  for (const role of ["root", "subagent"] as const) {
    expect(delegationPrompt("gpt-6-astra", "ultra", role)).toContain(`<multi_agent_mode>\n${upstream.defaults.proactive}\n</multi_agent_mode>`);
    for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
      expect(delegationPrompt("gpt-6-astra", effort, role).join("\n")).toContain(upstream.defaults.explicit);
    }
  }
});

test("models without role text or a recognized GPT identifier use bundled Codex V2 guidance", () => {
  for (const model of ["gpt-5.6-sol", "claude-opus-4-6", "custom-astra", undefined]) {
    const prompt = delegationPrompt(model, "medium", "root").join("\n");
    expect(prompt).toContain("You are `/root`, the primary agent");
    expect(prompt).not.toContain("Always put proper spaces between words and/or numbers.");
    expect(prompt).toContain(upstream.defaults.explicit);
  }
});

test("Pi rebuilds model contributions without retaining the previous model's role text", async () => {
  const { createAgentSession, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { createAtelierResourceLoader } = await import("../../../agent/src/server/system-prompt.ts");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "atelier-model-prompt-"));
  let active: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  try {
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, JSON.stringify({ openai: { type: "api_key", key: "offline-test" } }));
    const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
    const base = modelRuntime.getModel("openai", "gpt-4o")!;
    const astra = { ...base, id: "gpt-6-astra", reasoning: true };
    const { session } = await createAgentSession({
      cwd: dir, agentDir: dir, modelRuntime, model: astra, thinkingLevel: "medium",
      sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory(), tools: [],
      resourceLoader: createAtelierResourceLoader([], () => ["Atelier identity",
        ...(active ? delegationPrompt(active.model?.id, active.thinkingLevel, "subagent") : [])]),
    });
    active = session;
    session.setActiveToolsByName(session.getActiveToolNames());
    expect(session.systemPrompt).toContain("Always put proper spaces between words and/or numbers.");
    expect(session.systemPrompt).toContain("Atelier identity");
    expect(session.systemPrompt).toContain(upstream.defaults.explicit);
    await session.setModel(base);
    session.setActiveToolsByName(session.getActiveToolNames());
    expect(session.systemPrompt).not.toContain("Always put proper spaces between words and/or numbers.");
    expect(session.systemPrompt.match(/<multi_agent_role>/g)).toHaveLength(1);
    await session.setModel(astra);
    session.setThinkingLevel("medium");
    session.setActiveToolsByName(session.getActiveToolNames());
    expect(session.systemPrompt).toContain("Always put proper spaces between words and/or numbers.");
    expect(session.systemPrompt.match(/<multi_agent_mode>/g)).toHaveLength(1);
  } finally {
    active?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
