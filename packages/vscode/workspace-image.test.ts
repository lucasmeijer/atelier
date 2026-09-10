import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "./workspace-image.json";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))); });

for (const [architecture, serverArchitecture] of [["amd64", "x64"], ["arm64", "arm64"]]) {
  test(`VS Code image downloads the matching ${architecture} server without starting a listener`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "atelier-vscode-image-"));
    directories.push(directory);
    const bin = join(directory, "bin");
    const archiveRoot = join(directory, "archive", "server");
    await mkdir(bin);
    await mkdir(join(archiveRoot, "bin"), { recursive: true });
    const executable = async (path: string, body: string) => {
      await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
      await chmod(path, 0o755);
    };
    await executable(join(archiveRoot, "bin/code-server"), '[ "$*" = "--version" ]; echo server-version');
    const archive = join(directory, "server.tar.gz");
    expect(Bun.spawnSync(["tar", "-czf", archive, "-C", join(directory, "archive"), "server"]).exitCode).toBe(0);
    const commit = "a".repeat(40);
    await executable(join(bin, "code"), `[ "$1" = "--version" ]; printf '1.137.0\\n${commit}\\n${architecture}\\n'`);
    await executable(join(bin, "dpkg"), `echo ${architecture}`);
    await executable(join(bin, "curl"), `printf '%s\\n' "$2" > '${directory}/requested-url'; [ "$3" = "-o" ]; cp '${archive}' "$4"`);
    await executable(join(bin, "chown"), ":");
    await executable(join(bin, "su"), '[ "$1" = atelier ]; [ "$2" = -c ]; exec sh -c "$3"');
    // Exercise the archive provisioning block, not an editor or browser UI.
    const run = manifest.run[0];
    const script = run.slice(run.indexOf("code_commit="), run.indexOf("chmod -R a+rX"))
      .replaceAll("/home/atelier/", `${directory}/home/atelier/`)
      .replaceAll("/tmp/vscode-server.tar.gz", `${directory}/download.tar.gz`);
    const result = Bun.spawnSync(["sh", "-eu", "-c", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("server-version");
    expect(await readFile(join(directory, "requested-url"), "utf8")).toBe(`https://update.code.visualstudio.com/commit:${commit}/server-linux-${serverArchitecture}-web/stable\n`);
    expect(await readFile(join(directory, `home/atelier/.vscode/cli/serve-web/Stable-${commit}/server/bin/code-server`), "utf8")).toContain("server-version");
  });
}
