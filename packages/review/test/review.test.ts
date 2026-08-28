import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectReviewSnapshot, type ReviewFile } from "../src/server/diff.ts";
import { renderReviewBody } from "../src/server/render.ts";
import { remapReviewComment, type ReviewComment } from "../src/server/state.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function command(root: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atelier-review-"));
  roots.push(root);
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

describe("Review snapshot", () => {
  test("reports a non-repository without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "atelier-review-not-git-"));
    roots.push(root);
    expect((await collectReviewSnapshot(root)).phase).toBe("not-git");
  });

  test("combines tracked and untracked working changes while excluding ignored files", async () => {
    const root = await repository();
    await writeFile(join(root, "changed.ts"), "const after = true;\nconst added = 1;\n");
    await writeFile(join(root, "untracked.ts"), "export const newFile = true;\n");
    await writeFile(join(root, "ignored.txt"), "not reviewed\n");

    const snapshot = await collectReviewSnapshot(root);
    expect(snapshot.phase).toBe("ready");
    if (snapshot.phase !== "ready") throw new Error("expected ready review");
    expect(snapshot.files.map((file) => file.path)).toEqual(["changed.ts", "untracked.ts"]);
    expect(snapshot.files[0]!.additions).toBe(2);
    expect(snapshot.files[0]!.deletions).toBe(1);
    expect(snapshot.files[1]!.kind).toBe("text");
  });

  test("keeps empty files and rename metadata", async () => {
    const root = await repository();
    await command(root, "git", "mv", "empty.txt", "renamed.txt");
    const snapshot = await collectReviewSnapshot(root);
    if (snapshot.phase !== "ready") throw new Error("expected ready review");
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]!.path).toBe("renamed.txt");
    expect(snapshot.files[0]!.previousPath).toBe("empty.txt");
    expect(snapshot.files[0]!.detail).toBe("File renamed");
  });

  test("omits a staged addition deleted again before review", async () => {
    const root = await repository();
    const transient = join(root, "transient.ts");
    await writeFile(transient, "temporary\n");
    await command(root, "git", "add", "transient.ts");
    await rm(transient);
    const snapshot = await collectReviewSnapshot(root);
    if (snapshot.phase !== "ready") throw new Error("expected ready review");
    expect(snapshot.files).toEqual([]);
  });

  test("classifies binary changes without rendering them as text", async () => {
    const root = await repository();
    await writeFile(join(root, "asset.bin"), new Uint8Array([0, 1, 2, 3]));
    const snapshot = await collectReviewSnapshot(root);
    if (snapshot.phase !== "ready") throw new Error("expected ready review");
    expect(snapshot.files[0]!.kind).toBe("binary");
  });
});

describe("Review comment anchors", () => {
  const comment: ReviewComment = {
    id: "comment-1",
    path: "src/example.ts",
    side: "additions",
    startLine: 2,
    endLine: 2,
    body: "Keep this lazy",
    snippet: "target",
  };

  function file(contents: string): ReviewFile {
    return { path: comment.path, kind: "text", newContents: contents, additions: 1, deletions: 1 };
  }

  test("keeps exact anchors, remaps one exact match, and marks ambiguous matches outdated", () => {
    expect(remapReviewComment(comment, file("before\ntarget\nafter"))).toMatchObject({ startLine: 2, outdated: undefined });
    expect(remapReviewComment(comment, file("inserted\nbefore\ntarget\nafter"))).toMatchObject({ startLine: 3, endLine: 3, outdated: undefined });
    expect(remapReviewComment(comment, file("target\nbetween\ntarget"))).toMatchObject({ outdated: true });
    expect(remapReviewComment(comment, undefined)).toMatchObject({ outdated: true });
  });
});

describe("Review presentation", () => {
  test("renders explicit empty and not-git states", async () => {
    const empty = await renderReviewBody("workspace 1", { phase: "ready", files: [], additions: 0, deletions: 0 }, []);
    expect(empty).toContain("No changes to review");
    expect(empty).toContain("/workspaces/workspace%201/review/refresh");

    const notGit = await renderReviewBody("workspace 1", { phase: "not-git" }, []);
    expect(notGit).toContain("Not a git repository");
  });
});
