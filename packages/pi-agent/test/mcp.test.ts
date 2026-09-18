import { expect, test } from "bun:test";
import { join } from "node:path";

test("prepares a bundled session-private MCP extension without putting its credential in the command", async () => {
  const source = join(import.meta.dir, "../src/server/mcp.ts");
  const child = Bun.spawn([process.execPath, "-e", `
    import { expect, mock } from "bun:test";
    const workspace = await import("@atelier/workspace");
    const calls = [];
    mock.module("@atelier/workspace", () => ({ ...workspace, execWorkspaceShell: async (...args) => { calls.push(args); return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 }; } }));
    const { preparePiMcp, piAtelierExtensionPath } = await import(${JSON.stringify(source)});
    const mcp = { url: "http://127.0.0.1:2988/mcp", token: "private-bearer-token" };
    expect(await preparePiMcp("workspace", { id: "session", turnFinishedCommand: "/session/finished.sh" }, mcp)).toEqual({});
    expect(calls).toHaveLength(1);
    const [, command, options] = calls[0];
    expect(command).toContain("umask 077");
    expect(command).toContain(piAtelierExtensionPath("session"));
    expect(command).not.toContain(mcp.token);
    const count = Number(command.match(/count=(\\d+)/)[1]);
    const input = Buffer.from(options.stdin);
    expect(input.subarray(0, count).toString()).toContain("pi-atelier");
    expect(JSON.parse(input.subarray(count).toString())).toEqual({ ...mcp, turnFinishedCommand: "/session/finished.sh" });
  `], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
