import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "@atelier/core";
import { claudeLaunchScript } from "../src/server/launch-command.ts";
import { claudeMcpConfigPath } from "../src/server/mcp.ts";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "claude-launch-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function executable(path: string, script: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/bash\n${script}`);
  await chmod(path, 0o755);
}
function run(script: string) {
  const child = Bun.spawn(["/bin/bash", "-c", script], { env: { ...process.env, HOME: home, PATH: `${home}/.local/bin:${home}/tools:/usr/local/bin:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
}
const empty = { text: "", images: [], attachmentNotes: [] };
const sessionId = "1f2e3d4c-0000-4000-8000-000000000001";
const baseArgs = ["--dangerously-skip-permissions", "--settings", JSON.stringify({ skipDangerousModePermissionPrompt: true })];

test("reuses home Claude and passes initial prompt, image paths and file notes as literal arguments", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  const text = `--help 'quoted' $(touch ${home}/injected)\nsecond line`;
  const notes = "[Attached file copied into the workspace at /tmp/atelier-attachments/my file.txt]";
  const image = "/tmp/atelier-attachments/image 1.png";
  const [code, output] = await run(claudeLaunchScript({ ...empty, text, attachmentNotes: [notes] }, [image]));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--", `${text}\n\n${notes}\n\nRead the attached image at ${JSON.stringify(image)}.`]);
  expect(await Bun.file(`${home}/injected`).exists()).toBe(false);
});

test("empty launch has no initial prompt argument", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  const [code, output] = await run(claudeLaunchScript(empty, []));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual(baseArgs);
});

test("concurrent launches install latest once in shared home and both run", async () => {
  await executable(`${home}/tools/npm`, `printf '%s\\n' "$*" >> ${shellQuote(`${home}/installs`)}
sleep .1
mkdir -p "$3/node_modules/.bin"
printf '#!/bin/sh\\nprintf "CLAUDE_STARTED\\\\n"\\n' > "$3/node_modules/.bin/claude"
chmod +x "$3/node_modules/.bin/claude"`);
  // Do not reuse the old arbitrary npm prefix: Claude mistakes it for global.
  await executable(`${home}/.local/bin/claude`, "echo OLD_INSTALL; exit 9");
  const results = await Promise.all([run(claudeLaunchScript(empty, [])), run(claudeLaunchScript(empty, []))]);
  for (const [code, output] of results) { expect(code).toBe(0); expect(output).toContain("CLAUDE_STARTED"); }
  const installs = (await readFile(`${home}/installs`, "utf8")).trim().split("\n");
  expect(installs).toHaveLength(1);
  expect(installs[0]).toContain("@anthropic-ai/claude-code@latest");
  expect(await Bun.file(`${home}/.claude/local/node_modules/.bin/claude`).exists()).toBe(true);
});

test("installation failure exits visibly without running a fallback shell", async () => {
  await executable(`${home}/tools/npm`, "echo registry-unavailable >&2; exit 42");
  const [code, output, error] = await run(claudeLaunchScript(empty, []));
  expect(code).toBe(42);
  expect(error).toContain("registry-unavailable");
  expect(output).toContain("Claude Code failed (exit 42)");
  expect(await Bun.file(`${home}/.claude/local/node_modules/.bin/claude`).exists()).toBe(false);
});

test("Claude startup failure retains its exit code and diagnostics", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, "echo invalid-configuration >&2; exit 7");
  const [code, output, error] = await run(claudeLaunchScript(empty, []));
  expect(code).toBe(7);
  expect(error).toContain("invalid-configuration");
  expect(output).toContain("Claude Code failed (exit 7)");
});

test("passes the chosen Claude model and thinking level to the CLI", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  const [code, output] = await run(claudeLaunchScript(empty, [], { model: "anthropic::claude-opus-4-6", thinkingLevel: "high" }));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--model", "claude-opus-4-6", "--effort", "high"]);
});

test("prepares onboarding and workspace trust while preserving existing preferences", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  await writeFile(`${home}/.claude.json`, JSON.stringify({ theme: "light", custom: "keep", projects: { "/work": { allowedTools: ["Read"] }, "/other": { hasTrustDialogAccepted: true } } }));
  const [code] = await run(claudeLaunchScript(empty, []));
  expect(code).toBe(0);
  expect(JSON.parse(await readFile(`${home}/.claude.json`, "utf8"))).toEqual({
    theme: "light", custom: "keep", installMethod: "local", autoUpdates: true, hasCompletedOnboarding: true,
    projects: { "/work": { allowedTools: ["Read"], hasTrustDialogAccepted: true }, "/other": { hasTrustDialogAccepted: true } },
  });
});

test("invalid CLI preferences fail visibly rather than being overwritten", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'echo SHOULD_NOT_START');
  await writeFile(`${home}/.claude.json`, "invalid json");
  const [code, output, error] = await run(claudeLaunchScript(empty, []));
  expect(code).not.toBe(0);
  expect(error).toContain("SyntaxError");
  expect(output).not.toContain("SHOULD_NOT_START");
  expect(await readFile(`${home}/.claude.json`, "utf8")).toBe("invalid json");
});

for (const preferences of [{}, { autoUpdates: false }, { installMethod: "native", autoUpdates: false, autoUpdatesProtectedForNative: true }]) {
  test(`enables local Claude self-updates before launch with preferences ${JSON.stringify(preferences)}`, async () => {
    await writeFile(`${home}/.claude.json`, JSON.stringify(preferences));
    await executable(`${home}/.claude/local/node_modules/.bin/claude`, `node -e 'const fs = require("node:fs"); process.stdout.write(fs.readFileSync(process.env.HOME + "/.claude.json", "utf8"))'`);
    const [code, output] = await run(claudeLaunchScript(empty, []));
    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ ...preferences, installMethod: "local", autoUpdates: true });
  });
}

test("registers session-local turn boundary hooks", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  const command = `${home}/turn signal.sh`;
  const [code, output] = await run(claudeLaunchScript(empty, [], {}, { id: sessionId, turnSignalCommand: command }));
  expect(code).toBe(0);
  const args = output.split("\0");
  expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toMatchObject({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `sh ${shellQuote(command)} started` }] }],
    Stop: [{ hooks: [{ type: "command", command: `sh ${shellQuote(command)} finished` }] }],
  } });
});

test("adds the session-local Atelier MCP configuration without disabling the user's own servers", async () => {
  await executable(`${home}/.claude/local/node_modules/.bin/claude`, 'printf "%s\\0" "$@"');
  const [code, output] = await run(claudeLaunchScript(empty, [], {}, { id: sessionId, turnSignalCommand: `${home}/turn signal.sh` }));
  expect(code).toBe(0);
  const args = output.split("\0");
  expect(args[args.indexOf("--mcp-config") + 1]).toBe(claudeMcpConfigPath(sessionId));
  expect(args).not.toContain("--strict-mcp-config");
});
