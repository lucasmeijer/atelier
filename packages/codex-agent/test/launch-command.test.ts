import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "@atelier/core";
import { codexLaunchScript } from "../src/server/launch-command.ts";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "codex-launch-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function executable(path: string, script: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/bash\n${script}`);
  await chmod(path, 0o755);
}
function run(script: string) {
  const child = Bun.spawn(["/bin/bash", "-c", script], { env: { ...process.env, HOME: home, PATH: `${home}/.local/bin:${home}/tools:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
}
const empty = { text: "", images: [], attachmentNotes: [] };
const baseArgs = ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--no-alt-screen", "--cd", "/work", "-c", 'projects={"/work"={trust_level="trusted"}}', "-c", "notice.hide_full_access_warning=true", "-c", "check_for_update_on_startup=false", "-c", 'cli_auth_credentials_store="file"'];

test("reuses home Codex and passes initial prompt, image paths and file notes as literal arguments", async () => {
  await executable(`${home}/.local/bin/codex`, 'printf "%s\\0" "$@"');
  const text = `--help 'quoted' $(touch ${home}/injected)\nsecond line`;
  const notes = "[Attached file copied into the workspace at /work/.atelier-attachments/my file.txt]";
  const image = "/work/.atelier-attachments/image 1.png";
  const [code, output] = await run(codexLaunchScript({ ...empty, text, attachmentNotes: [notes] }, [image]));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--image", image, "--", `${text}\n\n${notes}`]);
  expect(await Bun.file(`${home}/injected`).exists()).toBe(false);
});

test("empty launch has no initial prompt argument", async () => {
  await executable(`${home}/.local/bin/codex`, 'printf "%s\\0" "$@"');
  const [code, output] = await run(codexLaunchScript(empty, []));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual(baseArgs);
});

test("concurrent launches install latest once in shared home and both run", async () => {
  await executable(`${home}/tools/npm`, `printf '%s\\n' "$*" >> ${shellQuote(`${home}/installs`)}
sleep .1
mkdir -p "$3/node_modules/.bin"
printf '#!/bin/sh\\nprintf "CODEX_STARTED\\\\n"\\n' > "$3/node_modules/.bin/codex"
chmod +x "$3/node_modules/.bin/codex"`);
  const results = await Promise.all([run(codexLaunchScript(empty, [])), run(codexLaunchScript(empty, []))]);
  for (const [code, output] of results) { expect(code).toBe(0); expect(output).toContain("CODEX_STARTED"); }
  const installs = (await readFile(`${home}/installs`, "utf8")).trim().split("\n");
  expect(installs).toHaveLength(1);
  expect(installs[0]).toContain("@openai/codex@latest");
  expect(await Bun.file(`${home}/.codex-cli/node_modules/.bin/codex`).exists()).toBe(true);
});

test("installation failure exits visibly without running a fallback shell", async () => {
  await executable(`${home}/tools/npm`, "echo registry-unavailable >&2; exit 42");
  const [code, output, error] = await run(codexLaunchScript(empty, []));
  expect(code).toBe(42);
  expect(error).toContain("registry-unavailable");
  expect(output).toContain("Codex failed (exit 42)");
  expect(await Bun.file(`${home}/.local/bin/codex`).exists()).toBe(false);
});

test("Codex startup failure retains its exit code and diagnostics", async () => {
  await executable(`${home}/.local/bin/codex`, "echo invalid-configuration >&2; exit 7");
  const [code, output, error] = await run(codexLaunchScript(empty, []));
  expect(code).toBe(7);
  expect(error).toContain("invalid-configuration");
  expect(output).toContain("Codex failed (exit 7)");
});

test("passes the chosen Codex model and thinking level to the CLI", async () => {
  await executable(`${home}/.local/bin/codex`, 'printf "%s\\0" "$@"');
  const [code, output] = await run(codexLaunchScript(empty, [], { model: "openai-codex::gpt-5.4", thinkingLevel: "high" }));
  expect(code).toBe(0);
  expect(output.split("\0").slice(0, -1)).toEqual([...baseArgs, "--model", "gpt-5.4", "-c", 'model_reasoning_effort="high"']);
});

test("registers a session-local turn completion notification", async () => {
  await executable(`${home}/.local/bin/codex`, 'printf "%s\\0" "$@"');
  const command = `${home}/turn finished.sh`;
  const [code, output] = await run(codexLaunchScript(empty, [], {}, command));
  expect(code).toBe(0);
  expect(output.split("\0")).toContain(`notify=${JSON.stringify(["sh", command])}`);
});
