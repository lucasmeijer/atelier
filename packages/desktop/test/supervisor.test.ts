import { expect, test } from "bun:test";

test("workspace desktop supervisor lifecycle", async () => {
  const process = Bun.spawn(["python3", "-B", new URL("./supervisor_test.py", import.meta.url).pathname], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (exitCode !== 0) throw new Error(stdout + stderr);
  expect(exitCode).toBe(0);
});
