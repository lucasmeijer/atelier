import { AtelierCoreError } from "./errors.ts";

export type UnpushedCommit = { hash: string; subject: string };

/** Commits reachable from local branches or detached HEAD, but no known remote branch.
 * Uses local remote-tracking refs only; an unborn HEAD is ignored.
 */
export async function collectUnpushedCommits(
  runGit: (args: string[]) => Promise<{ stdout: string | Buffer; stderr: string; exitCode: number }>,
): Promise<UnpushedCommit[]> {
  const result = await runGit(["log", "--format=%H%x00%s", "--ignore-missing", "HEAD", "--branches", "--not", "--remotes", "--"]);
  if (result.exitCode !== 0) throw new AtelierCoreError("git_error", result.stderr.trim() || "could not check unpushed commits");
  return result.stdout.toString().split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("\0");
    return { hash: line.slice(0, separator), subject: line.slice(separator + 1) };
  });
}
