import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function scenario(script: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "terminal-lifecycle-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      const workspace = await import("@atelier/workspace");
      const observable = await import("@atelier/observable-terminal/server");
      const sessions = new Map();
      let failCreation = false, callbacks;
      mock.module("@atelier/workspace", () => ({ ...workspace, execWorkspaceShell: async (id, command) => {
        await Bun.sleep(5);
        if (!sessions.has(id)) sessions.set(id, new Set());
        const names = sessions.get(id);
        const result = { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
        if (command.includes("list-sessions")) result.stdout = [...names].map(name => [name, 0, 0, "bash"].join("\\u001f")).join("\\n");
        if (command.includes("new-session")) {
          const name = command.match(/new-session -d -s '([^']+)'/)[1];
          if (failCreation || names.has(name)) { failCreation = false; return { ...result, exitCode: 1, stderr: "creation failed" }; }
          names.add(name);
        }
        if (command.includes("kill-session")) names.delete(command.match(/kill-session -t '([^']+)'/)[1]);
        return result;
      } }));
      mock.module("@atelier/observable-terminal/server", () => ({ ...observable, attachObservableTerminal: (_options, events) => {
        callbacks = events;
        return { write() {}, resize() {}, close() {} };
      } }));
      const { createWorkspaceTerminal: create, attachWorkspaceTerminal: attach, deleteWorkspaceTerminal: remove, listWorkspaceTerminals: list } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/workspace-terminals.ts"))});
      ${script}
    `], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, ATELIER_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("concurrent terminal creation allocates distinct names and retains every record", () => scenario(`
  const created = await Promise.all(Array.from({ length: 8 }, () => create("one")));
  expect(new Set(created.map(t => t.tmuxSession)).size).toBe(8);
  expect(await list("one")).toEqual(created);
  expect(sessions.get("one").size).toBe(8);
`));

test("create, attach and delete serialize together and recover after rejected operations", () => scenario(`
  const original = await create("one");
  sessions.get("one").add("external");
  const [, attached, created] = await Promise.all([remove("one", original.id), attach("one", "external"), create("one")]);
  expect(await list("one")).toEqual([attached, created]);
  await remove("one", attached.id);
  expect(sessions.get("one").has("external")).toBe(true);
  failCreation = true;
  const [failed, recovered] = await Promise.allSettled([create("one"), create("one")]);
  expect(failed.status).toBe("rejected");
  expect(recovered.status).toBe("fulfilled");
  expect(await list("one")).toHaveLength(2);
`));

test("terminal socket sends final diagnostics before closing", () => scenario(`
  const terminal = await create("one");
  const { createTerminalSocketHandler } = await import(${JSON.stringify(join(import.meta.dir, "../../src/server/sockets.ts"))});
  const handler = createTerminalSocketHandler({ setViewBusy() {} });
  const { terminalViewKey } = await import(${JSON.stringify(join(import.meta.dir, "../../src/shared.ts"))});
  const connection = await handler(new URL("http://localhost/workspaces/one/views/" + encodeURIComponent(terminalViewKey(terminal.id)) + "/ws"));
  const events = [];
  connection.open({ send: chunk => events.push(new TextDecoder().decode(chunk)), close: () => events.push("closed") });
  callbacks.onData(new TextEncoder().encode("can't find session"));
  callbacks.onExit(1);
  expect(events).toEqual(["can't find session", "closed"]);
`));
