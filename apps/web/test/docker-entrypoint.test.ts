import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entrypoint = await Bun.file(new URL("../docker-entrypoint.sh", import.meta.url)).text();
const defaultCommand = ["bun", "run", "apps/web/src/server/main.ts"];

function run(args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "atelier-entrypoint-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const command = (name: string, body: string) => {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
      return path;
    };
    command("getent", `case "$1" in
      group) echo 'atelier:x:1000:' ;;
      passwd) echo 'atelier:x:1000:1000:Atelier:/home/atelier:/bin/sh' ;;
      *) exit 1 ;;
    esac`);
    for (const name of ["chown", "usermod"]) command(name, ":");
    command("gosu", 'printf "APP\\n"; printf "<%s>\\n" "$@"');
    const script = join(directory, "entrypoint.sh");
    writeFileSync(script, entrypoint
      .replaceAll("/var/run/docker.sock", join(directory, "docker.sock"))
      .replaceAll("/run/containerd/containerd.sock", join(directory, "containerd.sock"))
      .replaceAll("/data/app", join(directory, "data"))
      .replaceAll("/etc/sudoers.d/atelier-tailscale-serve", join(directory, "sudoers")));
    const result = Bun.spawnSync(["sh", script, ...args], {
      stdin: "ignore",
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`,
      },
    });
    return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const args of [[], defaultCommand, ["custom-app", "argument with spaces"]]) {
  test(`app entrypoint runs command without starting infrastructure: ${JSON.stringify(args)}`, () => {
    const result = run(args);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`APP\n${["atelier", ...(args.length ? args : defaultCommand)].map((arg) => `<${arg}>\n`).join("")}`);
  });
}
