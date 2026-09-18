import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { shellQuote } from "@atelier/core";
import { piLaunchScript } from "../src/server/launch-command.ts";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "pi-launch-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const binary = () => `${home}/.pi-cli/${VERSION}/node_modules/.bin/pi`;
async function executable(path: string, script: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/bash\n${script}`);
  await chmod(path, 0o755);
}
function run(script: string) {
  const child = Bun.spawn(["/bin/bash", "-c", script], { env: { ...process.env, HOME: home, PATH: `${home}/tools:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
}
const empty = { text: "", images: [], attachmentNotes: [] };
const baseArgs = ["--approve", "--offline", "--tui-mode", "regular", "--session-dir", "/home/atelier/.local/share/pi/sessions"];

test("passes initial prompt, images, file notes, provider and Pi thinking level literally", async () => {
  await executable(binary(), 'printf "%s\\0" "$@"');
  const text = `--help 'quoted' $(touch ${home}/injected)\nsecond line`;
  const notes = "File: /work/.atelier-attachments/my file.txt";
  const image = "/work/.atelier-attachments/image 1.png";
  const [code, output] = await run(piLaunchScript({ ...empty, text, attachmentNotes: [notes] }, [image], { model: "anthropic::claude", thinkingLevel: "minimal" }));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--provider", "anthropic", "--model", "claude", "--thinking", "minimal", "--", `@${image}`, `${text}\n\n${notes}`]);
  expect(await Bun.file(`${home}/injected`).exists()).toBe(false);
});

test("@-prefixed messages are not interpreted as file arguments by Pi", async () => {
  await executable(binary(), 'printf "%s\\0" "$@"');
  const [code, output] = await run(piLaunchScript({ ...empty, text: "@someone inspect this" }, []));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--", "\n@someone inspect this"]);
});

test("empty launch stays interactive without submitting a prompt", async () => {
  await executable(binary(), 'printf "%s\\0" "$@"');
  const [code, output] = await run(piLaunchScript(empty, []));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--"]);
});

test("concurrent launches install exactly Atelier's version once", async () => {
  await executable(`${home}/tools/npm`, `printf '%s\\n' "$*" >> ${shellQuote(`${home}/installs`)}
sleep .1
mkdir -p "$3/node_modules/.bin"
printf '#!/bin/sh\\nprintf "PI_STARTED\\\\n"\\n' > "$3/node_modules/.bin/pi"
chmod +x "$3/node_modules/.bin/pi"`);
  const results = await Promise.all([run(piLaunchScript(empty, [])), run(piLaunchScript(empty, []))]);
  for (const [code, output] of results) { expect(code).toBe(0); expect(output).toContain("PI_STARTED"); }
  const installs = (await readFile(`${home}/installs`, "utf8")).trim().split("\n");
  expect(installs).toHaveLength(1);
  expect(installs[0]).toContain(`@earendil-works/pi-coding-agent@${VERSION}`);
});

test("installation and startup failures keep their exit codes and diagnostics", async () => {
  await executable(`${home}/tools/npm`, "echo registry-unavailable >&2; exit 42");
  const [code, output, error] = await run(piLaunchScript(empty, []));
  expect(code).toBe(42);
  expect(error).toContain("registry-unavailable");
  expect(output).toContain("Pi failed (exit 42)");
  await executable(binary(), "echo invalid-configuration >&2; exit 7");
  const [startupCode, startupOutput, startupError] = await run(piLaunchScript(empty, []));
  expect(startupCode).toBe(7);
  expect(startupError).toContain("invalid-configuration");
  expect(startupOutput).toContain("Pi failed (exit 7)");
});

test("pinned launches ignore other Pi versions on PATH without replacing them", async () => {
  await executable(`${home}/tools/pi`, 'echo WRONG_VERSION; exit 99');
  const oldBinary = `${home}/.pi-cli/0.0.0/node_modules/.bin/pi`;
  await executable(oldBinary, 'echo OLD_VERSION');
  await executable(`${home}/tools/npm`, `mkdir -p "$3/node_modules/.bin"
printf '#!/bin/sh\\nprintf "PINNED_VERSION\\\\n"\\n' > "$3/node_modules/.bin/pi"
chmod +x "$3/node_modules/.bin/pi"`);
  const [code, output] = await run(piLaunchScript(empty, []));
  expect(code).toBe(0);
  expect(output).toContain("PINNED_VERSION");
  expect(output).not.toContain("WRONG_VERSION");
  expect(await Bun.file(oldBinary).exists()).toBe(true);
  expect(await Bun.file(binary()).exists()).toBe(true);
});

test("registers an agent_end extension that invokes the completion command", async () => {
  await executable(binary(), 'printf "%s\\0" "$@"');
  const command = `${home}/turn finished.sh`;
  const [code, output] = await run(piLaunchScript(empty, [], {}, command));
  expect(code).toBe(0);
  expect(output.split("\0")).toContain(`${command}.ts`);
  const extension = await import(`${command}.ts`);
  let event: string | undefined;
  let handler: () => Promise<void>;
  const calls: unknown[] = [];
  extension.default({ on(name: string, callback: () => Promise<void>) { event = name; handler = callback; }, async exec(...args: unknown[]) { calls.push(args); return { code: 0 }; } });
  expect(event).toBe("agent_end");
  await handler!();
  expect(calls).toEqual([["sh", [command]]]);
});
