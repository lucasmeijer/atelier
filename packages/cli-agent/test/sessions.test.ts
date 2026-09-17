import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate dependency mocks and metadata caches; exercise the public module interface.
async function scenario(script: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cli-agent-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      const workspace = await import("@atelier/workspace");
      const calls = [];
      const launches = [];
      const preparations = [];
      const closedSessions = [];
      let setupError;
      let preparationError;
      let result = { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
      mock.module("@atelier/workspace", () => ({ ...workspace, execWorkspaceShell: async (...args) => { calls.push(args); return result; } }));
      const { createCliAgentModule } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/index.ts"))});
      const adapter = {
        id: "example", label: "Example CLI", iconHtml: "",
        requireSetup: async () => { if (setupError) throw setupError; },
        settings: {
          renderFooter: async () => "",
          prepare: async (settings = {}) => settings,
        },
        prepareWorkspace: async (workspaceId) => { preparations.push(workspaceId); if (preparationError) throw preparationError; },
        closeSession: async (workspaceId, id) => closedSessions.push({ workspaceId, id }),
        launchScript: (input, images, settings) => { launches.push({ input, images, settings }); return "printf 'CLI started'"; },
      };
      const module = createCliAgentModule(adapter);
      const provider = module.agentProvider;
      const saved = (workspaceId, providerId = "example") => Bun.file(process.env.ATELIER_DATA_DIR + "/workspaces/" + workspaceId + "/metadata/" + providerId + "-agents.json").json();
      const list = (workspaceId) => provider.tabs.list({ workspaceId });
      ${script}
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, ATELIER_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("creation materializes images and passes input and settings to the adapter once", () => scenario(`
  const input = { text: "Inspect this image", images: [{ mimeType: "image/png", data: "aW1hZ2U=" }], attachmentNotes: ["File: /work/notes.txt"] };
  const settings = { input, model: "any-provider::model", thinkingLevel: "custom", serviceTier: "fast" };
  await provider.launch.prepareWorkspace("initial", { agent: settings });
  const [tab] = await list("initial");
  expect(calls).toHaveLength(2);
  const image = "/work/.atelier-attachments/example-" + tab.id + "/0.png";
  expect(calls[0][1]).toContain(image);
  expect(calls[0][2]).toEqual({ stdin: "aW1hZ2U=" });
  expect(calls[1][1]).toContain("tmux -N new-session");
  expect(launches).toEqual([{ input, images: [image], settings }]);
  expect(preparations).toEqual(["initial"]);
  const [session] = (await saved("initial")).sessions;
  expect(session).toMatchObject({ id: tab.id, title: input.text, input, kind: "example", model: settings.model, thinkingLevel: "custom", tmuxSession: "example-" + tab.id });
  await list("initial");
  expect(calls).toHaveLength(2);
`));

test("startup failure leaves a durable tab with its actual error", () => scenario(`
  result = { ...result, stderr: "tmux service unavailable", exitCode: 1 };
  const id = await provider.create({ workspaceId: "failure" });
  expect((await saved("failure")).sessions[0]).toMatchObject({ id, error: "tmux service unavailable" });
  expect(closedSessions).toEqual([{ workspaceId: "failure", id }]);
  expect(await list("failure")).toEqual([{ id, title: "Example CLI" }]);
`));

test("adapter preparation failures are retained without launching a process", () => scenario(`
  preparationError = new Error("credentials could not be installed");
  await provider.create({ workspaceId: "failure" });
  expect((await saved("failure")).sessions[0].error).toBe(preparationError.message);
  expect(calls).toHaveLength(0);
  expect(launches).toHaveLength(0);
  await provider.launch.prepareWorkspace("failure");
  expect(preparations).toHaveLength(1);
`));

test("ended process retains its terminal until the tab is closed", () => scenario(`
  const id = await provider.create({ workspaceId: "ended" });
  result = { ...result, stdout: "1:42\\n" };
  const url = new URL("http://localhost/workspaces/ended/example-agents/" + id + "/status");
  const response = await module.routes[0].handle(new Request(url), url, {});
  expect(response.headers.get("X-CLI-Agent-Ended")).toBe("true");
  expect(calls.some(call => call[1].includes("kill-session"))).toBe(false);
  await provider.tabs.close({ workspaceId: "ended", conversationId: id });
  expect(calls.at(-1)[1]).toContain("tmux kill-session");
  expect(await list("ended")).toEqual([]);
`));

test("missing session closes without restarting or trying to kill it", () => scenario(`
  const id = await provider.create({ workspaceId: "missing" });
  calls.length = 0;
  result = { ...result, stderr: "can't find session", exitCode: 1 };
  await provider.tabs.close({ workspaceId: "missing", conversationId: id });
  expect(calls).toHaveLength(1);
  expect(calls[0][1]).toContain("tmux list-panes");
  expect(await list("missing")).toEqual([]);
  expect(launches).toHaveLength(1);
`));

test("unexpected inspection errors propagate and preserve the tab", () => scenario(`
  const id = await provider.create({ workspaceId: "broken" });
  result = { ...result, stderr: "container unavailable", exitCode: 125 };
  await expect(provider.tabs.close({ workspaceId: "broken", conversationId: id })).rejects.toMatchObject({ code: "example_session_check_failed" });
  expect(await list("broken")).toHaveLength(1);
`));

test("concurrent provisioning claims launch once, and recovery never resubmits", () => scenario(`
  const context = { agent: { input: { text: "Only once", images: [], attachmentNotes: [] } } };
  await Promise.all([provider.launch.prepareWorkspace("recovery", context), provider.launch.prepareWorkspace("recovery", context)]);
  await createCliAgentModule(adapter).agentProvider.launch.prepareWorkspace("recovery", context);
  expect(calls).toHaveLength(1);
  expect(launches).toHaveLength(1);
  expect(await list("recovery")).toHaveLength(1);
`));

test("providers and workspaces have independent session stores", () => scenario(`
  const other = createCliAgentModule({ ...adapter, id: "other", label: "Other CLI" }).agentProvider;
  const [first, second, third] = await Promise.all([
    provider.create({ workspaceId: "one" }), other.create({ workspaceId: "one" }), provider.create({ workspaceId: "two" }),
  ]);
  expect(new Set([first, second, third]).size).toBe(3);
  expect((await saved("one")).sessions.map(s => s.id)).toEqual([first]);
  expect((await saved("one", "other")).sessions.map(s => s.id)).toEqual([second]);
  expect((await saved("two")).sessions.map(s => s.id)).toEqual([third]);
`));

test("existing Codex placeholders and Claude sessions retain paths, IDs and tmux names", () => scenario(`
  for (const id of ["codex", "claude"]) {
    const session = { id: "old-" + id, title: "Existing tab", tmuxSession: id + "-existing", input: { text: "Never submit", images: [], attachmentNotes: [] }, model: "saved-model", thinkingLevel: "high", ...(id === "claude" ? { kind: id } : {}) };
    const path = process.env.ATELIER_DATA_DIR + "/workspaces/legacy/metadata/" + id + "-agents.json";
    await Bun.write(path, JSON.stringify({ sessions: [session] }));
    const legacy = createCliAgentModule({ ...adapter, id }).agentProvider;
    expect(await legacy.tabs.list({ workspaceId: "legacy" })).toEqual([{ id: session.id, title: session.title }]);
    await legacy.launch.prepareWorkspace("legacy");
    expect(await Bun.file(path).json()).toEqual({ sessions: [session] });
    await legacy.tabs.close({ workspaceId: "legacy", conversationId: session.id });
    expect(calls.at(-1)[1]).toContain(id + "-existing");
  }
  expect(launches).toHaveLength(0);
  expect(preparations).toHaveLength(0);
`));

test("setup errors reject before a session is claimed", () => scenario(`
  setupError = new Error("connect account");
  await expect(provider.create({ workspaceId: "no-auth" })).rejects.toThrow("connect account");
  await expect(provider.launch.prepare({})).rejects.toThrow("connect account");
  await expect(provider.launch.submit(new FormData())).rejects.toThrow("connect account");
  await expect(provider.launch.prepareWorkspace("no-auth")).rejects.toThrow("connect account");
  expect(await list("no-auth")).toEqual([]);
  expect(preparations).toHaveLength(0);
`));

test("launch settings are prepared by the adapter for both form and programmatic launches", () => scenario(`
  const settings = { model: "local::model", serviceTier: "fast" };
  expect(await provider.launch.prepare(settings)).toEqual({ agent: settings });
  const form = new FormData();
  form.set("model", "local::other");
  form.set("level", "high");
  const submitted = await provider.launch.submit(form);
  expect(await submitted.prepare()).toEqual({ agent: { model: "local::other", thinkingLevel: "high" } });
  const minimal = createCliAgentModule({ ...adapter, id: "minimal", prepareWorkspace: undefined }).agentProvider;
  await minimal.create({ workspaceId: "local" });
  expect(preparations).toHaveLength(0);
  expect(launches).toHaveLength(1);
`));
