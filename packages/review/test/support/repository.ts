import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function command(root: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
}

export async function createReviewRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atelier-review-"));
  await command(root, "git", "init", "-q");
  await command(root, "git", "config", "user.email", "review@example.test");
  await command(root, "git", "config", "user.name", "Review Test");
  await writeFile(join(root, "changed.ts"), "const before = true;\n");
  await writeFile(join(root, "empty.txt"), "");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await command(root, "git", "add", ".");
  await command(root, "git", "commit", "-qm", "initial");
  return root;
}
