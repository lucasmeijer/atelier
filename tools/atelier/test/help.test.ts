import { expect, test } from "bun:test";

async function runAtelier(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "tools/atelier/src/main.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

test("--help prints usage", async () => {
  const result = await runAtelier(["--help"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("atelier [--help]");
  expect(result.stdout).toContain("-h, --help");
});
