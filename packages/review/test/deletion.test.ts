import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDeletionReview, reviewDeletionReview } from "../src/server/deletion.ts";
import { command } from "./support/repository.ts";

const workspaceId = "de1e7e01";
let dataDir: string;
let previousDataDir: string | undefined;

beforeEach(async () => {
  previousDataDir = process.env.ATELIER_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), "atelier-deletion-review-"));
  process.env.ATELIER_DATA_DIR = dataDir;
});

afterEach(async () => {
  clearDeletionReview(workspaceId);
  if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

async function workspaceRepository(): Promise<string> {
  const root = join(dataDir, "workspaces", workspaceId, "work");
  await mkdir(root, { recursive: true });
  await command(root, "git", "init", "-q");
  await command(root, "git", "config", "user.email", "review@example.test");
  await command(root, "git", "config", "user.name", "Review Test");
  await writeFile(join(root, "tracked.txt"), "initial\n");
  await command(root, "git", "add", "tracked.txt");
  await command(root, "git", "commit", "-qm", "initial");
  return root;
}

describe("Workspace deletion review", () => {
  test("ignores local commits and does not contact the remote", async () => {
    const root = await workspaceRepository();
    await command(root, "git", "remote", "add", "origin", "https://127.0.0.1:1/unreachable.git");
    await writeFile(join(root, "committed.txt"), "local commit\n");
    await command(root, "git", "add", "committed.txt");
    await command(root, "git", "commit", "-qm", "local commit");

    expect(await reviewDeletionReview.inspect(workspaceId)).toEqual({ status: "clear" });
  });

  test("blocks deletion for uncommitted working-tree changes", async () => {
    const root = await workspaceRepository();
    await writeFile(join(root, "tracked.txt"), "changed\n");

    expect(await reviewDeletionReview.inspect(workspaceId)).toMatchObject({
      status: "blocked",
      details: {
        repositories: [{
          relativePath: "",
          uncommitted: [{ path: "tracked.txt", change: "modified", additions: 1, deletions: 1 }],
        }],
      },
    });
  });
});
