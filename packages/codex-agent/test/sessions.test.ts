import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the metadata cache and dependency mocks from the web app's provider registry.
async function scenario(script: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "codex-sessions-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      const workspace = await import("@atelier/workspace");
      const llm = await import("@atelier/llm/server");
      const calls = [];
      let result = { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
      mock.module("@atelier/workspace", () => ({ ...workspace, execWorkspaceShell: async (...args) => { calls.push(args); return result; } }));
      mock.module("@atelier/llm/server", () => ({ ...llm, installSubscriptionCli: async () => {} }));
      mock.module(${JSON.stringify(join(import.meta.dir, "../src/server/auth.ts"))}, () => ({ requireCodexSubscription: async () => {} }));
      const { closeCodexSession, codexSession, codexTerminalState, createCodexSession, listCodexSessions } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/sessions.ts"))});
      ${script}
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, ATELIER_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("creation materializes images and launches once; reads do not rerun prompts", () => scenario(`
  const input = { text: "Inspect this image", images: [{ mimeType: "image/png", data: "aW1hZ2U=" }], attachmentNotes: ["File: /work/.atelier-attachments/notes.txt"] };
  const id = await createCodexSession("initial", input);
  expect(calls).toHaveLength(2);
  expect(calls[0][1]).toContain("/work/.atelier-attachments/codex-" + id + "/0.png");
  expect(calls[0][2]).toEqual({ stdin: "aW1hZ2U=" });
  expect(calls[1][1]).toContain("tmux -N new-session");
  expect(codexSession("initial", id).input).toEqual(input);
  expect(codexSession("initial", id).kind).toBe("codex");
  expect(listCodexSessions("initial")).toHaveLength(1);
  expect(calls).toHaveLength(2);
`));

test("startup failure leaves a durable tab with its actual error", () => scenario(`
  result = { ...result, stderr: "tmux service unavailable", exitCode: 1 };
  const id = await createCodexSession("failure");
  expect(codexSession("failure", id).error).toBe("tmux service unavailable");
  const saved = await Bun.file(process.env.ATELIER_DATA_DIR + "/workspaces/failure/metadata/codex-agents.json").json();
  expect(saved.sessions[0].error).toBe("tmux service unavailable");
`));

test("ended process retains terminal output until the tab is closed", () => scenario(`
  const id = await createCodexSession("ended");
  result = { ...result, stdout: "1:42\\n" };
  expect(await codexTerminalState("ended", codexSession("ended", id))).toEqual({ exists: true, ended: true, exitCode: 42 });
  await closeCodexSession("ended", id);
  expect(calls.at(-1)[1]).toContain("tmux kill-session");
  expect(listCodexSessions("ended")).toEqual([]);
`));

test("missing tmux session stays ended and closing never restarts it", () => scenario(`
  const id = await createCodexSession("missing");
  calls.length = 0;
  result = { ...result, stderr: "can't find session", exitCode: 1 };
  expect(await codexTerminalState("missing", codexSession("missing", id))).toEqual({ exists: false, ended: true });
  await closeCodexSession("missing", id);
  expect(calls.every((call) => call[1].startsWith("tmux list-panes"))).toBe(true);
  expect(listCodexSessions("missing")).toEqual([]);
`));

test("provisioning recovery reuses its claimed session without submitting again", () => scenario(`
  const { atelierServerModule } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/index.ts"))});
  const context = { agent: { input: { text: "Only once", images: [], attachmentNotes: [] } } };
  await atelierServerModule.agentProvider.launch.prepareWorkspace("recovery", context);
  const first = listCodexSessions("recovery")[0].id;
  await atelierServerModule.agentProvider.launch.prepareWorkspace("recovery", context);
  expect(calls).toHaveLength(1);
  expect(listCodexSessions("recovery").map(session => session.id)).toEqual([first]);
`));
