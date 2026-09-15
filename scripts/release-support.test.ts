import { expect, test } from "bun:test";
import { commandRunner } from "./release-support.ts";

test("shared release command runner captures output and passes credentials only through stdin", async () => {
  let transcript = "";
  const runner = commandRunner(import.meta.dir, text => { transcript += text; });
  const result = await runner.run(["bun", "-e", 'const s=await Bun.stdin.text();process.stdout.write(String(s.length)+"\\n");process.stderr.write("diagnostic\\n");'], { input: "private-test-token" });
  expect(result.stdout).toBe("18\n");
  expect(result.stderr).toBe("diagnostic\n");
  expect(transcript).not.toContain("private-test-token");
});

test("streamed build output is not also retained in memory", async () => {
  let transcript = "";
  const runner = commandRunner(import.meta.dir, text => { transcript += text; });
  expect((await runner.run(["printf", "build output"], { stream: true })).stdout).toBe("");
  expect(transcript).toContain("build output");
});

test("runner exposes allowed failures and rejects unhandled command failures", async () => {
  const runner = commandRunner(import.meta.dir, () => {});
  expect((await runner.run(["false"], { allowFailure: true })).code).toBe(1);
  await expect(runner.run(["false"])).rejects.toThrow("exited 1");
});

test("stop terminates the active command", async () => {
  const runner = commandRunner(import.meta.dir, () => {});
  const result = runner.run(["sleep", "30"], { allowFailure: true });
  runner.stop();
  expect((await result).code).not.toBe(0);
});
