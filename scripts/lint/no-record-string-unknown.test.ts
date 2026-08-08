import { expect, test } from "bun:test";

const discouragedTypeName = ["Record<string", "unknown>"].join(",");
const guidance = `Do not use ${discouragedTypeName}.  Instead convert each instance to strongly typed domain types that have been parsed at the earliest time possible and as close to the io boundary the data originated from`;

test(guidance, () => {
  const result = Bun.spawnSync([
    "git",
    "grep",
    "--untracked",
    "-n",
    "-E",
    "Record[[:space:]]*<[[:space:]]*string[[:space:]]*,[[:space:]]*unknown[[:space:]]*>",
    "--",
    "*.ts",
    "*.tsx",
    "*.mts",
    "*.cts",
    "*.js",
    "*.jsx",
    "*.mjs",
    "*.cjs",
  ], { stdout: "pipe", stderr: "inherit" });
  if (result.exitCode === 0) throw new Error(`${guidance}\n\n${result.stdout.toString().trim()}`);
  expect(result.exitCode).toBe(1);
});
