import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entrypoint = await Bun.file(new URL("../docker-entrypoint.sh", import.meta.url)).text();
const defaultCommand = ["bun", "run", "apps/web/src/server/main.ts"];

function run(args: string[], options: { inherited?: boolean; hostData?: string } = {}) {
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
    const owner = command("atelier-owned-snapshotter", 'printf "OWNER\\n"; printf "<%s>\\n" "$@"');
    const connection = join(directory, "docker-runtime.json");
    if (options.inherited) {
      writeFileSync(connection, JSON.stringify({
        version: 1, adminSocket: "/shared/admin.sock", socketDirectory: "/shared",
        snapshotterRoot: "/shared/snapshots", depth: 1,
      }));
    }
    // Redirect container-only absolute paths into the fixture. Execute the actual
    // entrypoint with POSIX sh; stub only account setup and the two exec targets.
    const script = join(directory, "entrypoint.sh");
    writeFileSync(script, entrypoint
      .replaceAll("/.atelier/docker-runtime.json", connection)
      .replaceAll("/etc/sudoers.d/atelier-tailscale-serve", join(directory, "sudoers"))
      .replaceAll("/usr/local/bin/atelier-owned-snapshotter", owner));
    const result = Bun.spawnSync(["sh", script, ...args], {
      stdin: "ignore",
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`,
        ATELIER_DATA_DIR: join(directory, "data"),
        ATELIER_DOCKER_HOST_DATA_DIR: options.hostData ?? "",
      },
    });
    return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const args of [[], defaultCommand, ["custom-app", "argument with spaces"]]) {
  test(`standalone entrypoint owns services by default: ${JSON.stringify(args)}`, () => {
    const result = run(args, { hostData: "/srv/atelier" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`OWNER\n${["/srv/atelier/docker-runtime", "1000", "gosu", "atelier", ...(args.length ? args : defaultCommand)].map((arg) => `<${arg}>\n`).join("")}`);
  });
}

for (const args of [[], ["custom-app", "argument with spaces"]]) {
  test(`explicit nested entrypoint skips owned services: ${JSON.stringify(args)}`, () => {
    const result = run(["--nested", ...args], { inherited: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`APP\n${["atelier", ...(args.length ? args : defaultCommand)].map((arg) => `<${arg}>\n`).join("")}`);
  });
}

test("nested startup requires the inherited connection instead of starting an owner", () => {
  const result = run(["--nested"], { hostData: "/srv/atelier" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("--nested requires an inherited runtime connection");
  expect(result.stdout).toBe("");
});

test("standalone startup does not infer nested mode from an inherited connection", () => {
  const result = run([], { inherited: true });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("standalone Atelier requires Docker-host data path");
  expect(result.stdout).toBe("");
});

test("standalone mode remains owned when an inherited descriptor is present", () => {
  const result = run([], { inherited: true, hostData: "/srv/atelier" });
  expect(result.status).toBe(0);
  expect(result.stdout).toStartWith("OWNER\n");
});

for (const flag of ["--own-snapshotter", "--unknown"]) {
  test(`rejects unsupported entrypoint option ${flag}`, () => {
    const result = run([flag], { hostData: "/srv/atelier" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`unknown Atelier entrypoint option: ${flag}`);
    expect(result.stdout).toBe("");
  });
}
