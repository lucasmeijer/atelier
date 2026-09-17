import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const id of ["codex", "claude", "pi"]) {
  test(`${id} adapter validates settings, installs credentials and builds its CLI launch`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `${id}-adapter-`));
    const source = join(import.meta.dir, `../../../packages/${id}-agent/src/server`);
    const authExport = id === "pi" ? "requirePiModels" : id === "codex" ? "requireCodexSubscription" : "requireClaudeSubscription";
    const model = id === "pi" ? "custom::model" : id === "codex" ? "openai-codex::gpt-5.4" : "anthropic::claude-opus-4-6";
    const npmPackage = id === "pi" ? "@earendil-works/pi-coding-agent@" : id === "codex" ? "@openai/codex@latest" : "@anthropic-ai/claude-code@latest";
    try {
      const child = Bun.spawn([process.execPath, "-e", `
        import { expect, mock } from "bun:test";
        const workspace = await import("@atelier/workspace");
        const llm = await import("@atelier/llm/server");
        const agent = await import("@atelier/agent/server");
        const revoked = [];
        mock.module("@atelier/agent/server", () => ({ ...agent, prepareAgentMcp: async () => ({ url: "http://127.0.0.1:2988/mcp", token: "test-credential" }), revokeAgentMcp: async (...args) => revoked.push(args) }));
        const calls = [];
        const credentials = [];
        let authChecks = 0;
        mock.module("@atelier/workspace", () => ({ ...workspace, execWorkspaceShell: async (...args) => { calls.push(args); return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 }; } }));
        mock.module("@atelier/llm/server", () => ({ ...llm, installSubscriptionCli: async (workspaceId) => credentials.push(workspaceId) }));
        if (${JSON.stringify(id)} === "pi") mock.module(${JSON.stringify(join(source, "pi-cli.ts"))}, () => ({ installPiCliConfiguration: async (workspaceId) => credentials.push(workspaceId) }));
        mock.module(${JSON.stringify(join(source, "auth.ts"))}, () => ({ ${authExport}: async () => { authChecks++; } }));
        mock.module(${JSON.stringify(join(source, "model-settings.ts"))}, () => ({ ${id}ModelSettings: { prepare: async (settings = {}) => settings, renderFooter: async () => "" } }));
        const { atelierServerModule } = await import(${JSON.stringify(join(source, "index.ts"))});
        const provider = atelierServerModule.agentProvider;
        expect(provider.id).toBe(${JSON.stringify(id)});
        const form = new FormData();
        form.set("model", "${model}");
        form.set("level", "high");
        const submitted = await provider.launch.submit(form);
        const context = await submitted.prepare();
        expect(context.agent).toEqual({ model: form.get("model"), thinkingLevel: "high" });
        await provider.launch.prepareWorkspace("adapter", context);
        expect(authChecks).toBe(2);
        expect(credentials).toEqual(["adapter"]);
        expect(calls).toHaveLength(${id === "codex" ? 2 : 1});
        expect(calls.at(-1)[1]).toContain(${JSON.stringify(npmPackage)});
        expect(calls.at(-1)[1]).toContain("${id}-");
        expect(calls.at(-1)[1]).toContain("HOME=/home/atelier");
        expect(calls.at(-1)[1]).not.toContain("test-credential");
        const [tab] = await provider.tabs.list({ workspaceId: "adapter" });
        if (${id === "codex"}) {
          expect(calls[0][1]).toContain("config.toml");
          expect(calls[0][2].stdin).toContain('Authorization = "Bearer test-credential"');
          expect(calls.at(-1)[1]).toContain("CODEX_HOME=/home/atelier/.local/share/atelier-agents/" + tab.id + "/codex");
        }
        await provider.launch.prepareWorkspace("adapter", context);
        expect(calls).toHaveLength(${id === "codex" ? 2 : 1});
        await provider.tabs.close({ workspaceId: "adapter", conversationId: tab.id });
        expect(revoked).toEqual(${id === "codex" ? '[["adapter", tab.id]]' : '[]'});
      `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, ATELIER_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
