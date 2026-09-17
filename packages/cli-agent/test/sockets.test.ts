import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("each adapter exposes its own interactive terminal protocol", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cli-sockets-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      const workspace = await import("@atelier/workspace");
      const observable = await import("@atelier/observable-terminal/server");
      const writes = [], sizes = [], attachments = [];
      let callbacks, closed = 0;
      mock.module("@atelier/workspace", () => ({ ...workspace, execWorkspaceShell: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }) }));
      mock.module("@atelier/observable-terminal/server", () => ({ ...observable, attachObservableTerminal: (options, handlers) => {
        attachments.push(options); callbacks = handlers;
        return { write: text => writes.push(text), resize: (...size) => sizes.push(size), close: () => { closed++; } };
      } }));
      const { createCliAgentModule } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/index.ts"))});
      for (const providerId of ["codex", "claude"]) {
        const module = createCliAgentModule({
          id: providerId, label: providerId, iconHtml: "", requireSetup: async () => {},
          settings: { renderFooter: async () => "", prepare: async () => ({}) },
          launchScript: () => "true",
        });
        let handler;
        module.initialize({ registerSocketHandler: (value) => { handler = value; } });
        const id = await module.agentProvider.create({ workspaceId: "socket" });
        expect(await handler(new URL("http://localhost/workspaces/socket/unrelated-agents/" + id + "/ws"))).toBeUndefined();
        const route = "http://localhost/workspaces/socket/" + providerId + "-agents/";
        await expect(handler(new URL(route + "missing/ws"))).rejects.toMatchObject({ code: "agent_conversation_not_found" });
        const connection = await handler(new URL(route + id + "/ws?cols=120&rows=-1"));
        const output = [];
        let socketClosed = false;
        const socket = { send: chunk => output.push(chunk), close: () => { socketClosed = true; } };
        connection.open(socket);
        expect(attachments.at(-1)).toMatchObject({ session: providerId + "-" + id, cols: 120, rows: 24, readonly: false, user: "atelier", workdir: "/work" });
        connection.message(socket, "hello");
        connection.message(socket, new TextEncoder().encode("world"));
        connection.message(socket, JSON.stringify({ type: "resize", cols: 100, rows: 40 }));
        expect(writes.slice(-2)).toEqual(["hello", "world"]);
        expect(sizes.at(-1)).toEqual([100, 40]);
        callbacks.onData("output");
        expect(output).toEqual(["output"]);
        callbacks.onExit();
        expect(socketClosed).toBe(true);
        connection.close();
      }
      expect(closed).toBe(2);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, ATELIER_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
