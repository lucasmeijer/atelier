import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedConfigInstallScript } from "../src/startup-scripts.ts";

let directory: string;
let binDirectory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atelier-seed-startup-"));
  binDirectory = join(directory, "bin");
  await mkdir(binDirectory);
  await writeFile(join(binDirectory, "su"), `#!/bin/sh\nexec /bin/sh -c "$5" "$6" "$7"\n`);
  await writeFile(join(binDirectory, "install"), `#!/bin/sh\ncp "$7" "$8"\nchmod 600 "$8"\n`);
  await chmod(join(binDirectory, "su"), 0o755);
  await chmod(join(binDirectory, "install"), 0o755);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function run(script: string): Promise<{ exitCode: number; stderr: string }> {
  const process = Bun.spawn(["sh", "-eu", "-c", script], {
    env: { ...Bun.env, PATH: `${binDirectory}:${Bun.env.PATH}` },
    stderr: "pipe",
  });
  return { exitCode: await process.exited, stderr: await new Response(process.stderr).text() };
}

describe("seeded configuration startup", () => {
  test("installs the staging file once and preserves the destination across two later boots", async () => {
    const source = join(directory, "staging.json");
    const target = join(directory, "config", "seed.json");
    const script = seedConfigInstallScript(source, target);
    await writeFile(source, "opaque seed fixture");

    expect((await run(script)).exitCode).toBe(0);
    expect(await Bun.file(source).exists()).toBe(false);
    expect(await readFile(target, "utf8")).toBe("opaque seed fixture");

    await writeFile(target, "workspace-owned update");
    expect((await run(script)).exitCode).toBe(0);
    expect((await run(script)).exitCode).toBe(0);
    expect(await readFile(target, "utf8")).toBe("workspace-owned update");
  });

  test("continues when only the destination exists", async () => {
    const source = join(directory, "missing-staging.json");
    const target = join(directory, "seed.json");
    await writeFile(target, "existing destination");

    expect((await run(seedConfigInstallScript(source, target))).exitCode).toBe(0);
    expect(await readFile(target, "utf8")).toBe("existing destination");
  });

  test("fails clearly when both source and destination are missing", async () => {
    const source = join(directory, "missing-staging.json");
    const target = join(directory, "missing-seed.json");

    const result = await run(seedConfigInstallScript(source, target));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("workspace seed is missing from both");
    expect(result.stderr).toContain(source);
    expect(result.stderr).toContain(target);
  });

  test("does not suppress an installation failure", async () => {
    const source = join(directory, "staging.json");
    const target = join(directory, "seed.json");
    await writeFile(source, "opaque seed fixture");
    await writeFile(join(binDirectory, "install"), "#!/bin/sh\necho simulated install failure >&2\nexit 23\n");

    const result = await run(seedConfigInstallScript(source, target));
    expect(result.exitCode).toBe(23);
    expect(result.stderr).toContain("simulated install failure");
    expect(await Bun.file(source).exists()).toBe(true);
    expect(await Bun.file(target).exists()).toBe(false);
  });
});
