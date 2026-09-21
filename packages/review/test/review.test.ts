import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewCommentsPrompt, type ReviewCommentModel } from "../src/model.ts";
import { collectReviewFile, collectReviewIndex, collectReviewStats, type ReviewFile, type ReviewFileStats } from "../src/server/diff.ts";
import { renderReviewBody } from "../src/server/render.ts";
import { readReviewSettings, updateReviewSettings } from "../src/server/settings.ts";
import { addReviewComment, deleteReviewState, listReviewComments, remapReviewComment, updateReviewComment, type ReviewComment } from "../src/server/state.ts";
import { command, createReviewRepository } from "./support/repository.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await createReviewRepository();
  roots.push(root);
  return root;
}

async function reviewFiles(root: string): Promise<ReviewFile[]> {
  const index = await collectReviewIndex(root);
  if (index.phase !== "ready") throw new Error("expected ready review");
  const files = await Promise.all(index.files.map((file) => collectReviewFile(root, file.path)));
  return files.filter((file): file is ReviewFile => file !== undefined);
}

describe("Review collection", () => {
  test("reports a non-repository without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "atelier-review-not-git-"));
    roots.push(root);
    expect((await collectReviewIndex(root)).phase).toBe("not-git");
  });

  test("lists tracked and untracked changes without collecting file details", async () => {
    const root = await repository();
    await writeFile(join(root, "changed.ts"), "const after = true;\nconst added = 1;\n");
    await writeFile(join(root, "untracked.ts"), "export const newFile = true;\n");
    await writeFile(join(root, "ignored.txt"), "not reviewed\n");

    const index = await collectReviewIndex(root);
    expect(index).toEqual({ phase: "ready", files: [
      { path: "changed.ts", change: "modified" },
      { path: "untracked.ts", change: "added", untracked: true },
    ] });
    expect(await collectReviewStats(root, index)).toEqual([
      { path: "changed.ts", change: "modified", additions: 2, deletions: 1 },
      { path: "untracked.ts", change: "added", untracked: true, additions: 1, deletions: 0 },
    ]);

    const files = await reviewFiles(root);
    expect(files.map((file) => file.path)).toEqual(["changed.ts", "untracked.ts"]);
    expect(files[1]!.kind).toBe("text");
  });

  test("counts untracked text lines with or without a trailing newline", async () => {
    const root = await repository();
    for (const [path, text] of Object.entries({ "empty-new.txt": "", "newline.txt": "héllo\nworld\n", "no-newline.txt": "héllo\nworld" })) {
      await writeFile(join(root, path), text);
    }
    const stats = await collectReviewStats(root, await collectReviewIndex(root));
    expect(stats.map(({ path, additions }) => ({ path, additions }))).toEqual([
      { path: "empty-new.txt", additions: 0 },
      { path: "newline.txt", additions: 2 },
      { path: "no-newline.txt", additions: 2 },
    ]);
  });

  test("collects stats before the repository has its first commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "atelier-review-unborn-"));
    roots.push(root);
    await command(root, "git", "init");
    await writeFile(join(root, "first.ts"), "export const first = true;\n");
    await command(root, "git", "add", "first.ts");
    const index = await collectReviewIndex(root);
    expect(await collectReviewStats(root, index)).toEqual([{ path: "first.ts", change: "added", additions: 1, deletions: 0 }]);
  });

  test("classifies whole-file additions and removals", async () => {
    const root = await repository();
    await writeFile(join(root, "added.ts"), "export const added = true;\n");
    await rm(join(root, "changed.ts"));

    const index = await collectReviewIndex(root);
    if (index.phase !== "ready") throw new Error("expected ready review");
    expect(index.files.map(({ path, change }) => ({ path, change }))).toEqual([
      { path: "added.ts", change: "added" },
      { path: "changed.ts", change: "removed" },
    ]);
  });

  test("keeps empty files and rename metadata", async () => {
    const root = await repository();
    await command(root, "git", "mv", "empty.txt", "renamed.txt");
    const index = await collectReviewIndex(root);
    expect(await collectReviewStats(root, index)).toEqual([{ path: "renamed.txt", previousPath: "empty.txt", change: "modified", additions: 0, deletions: 0 }]);
    const files = await reviewFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("renamed.txt");
    expect(files[0]!.previousPath).toBe("empty.txt");
    expect(files[0]!.detail).toBe("File renamed");
  });

  test("omits a staged addition deleted again before review", async () => {
    const root = await repository();
    const transient = join(root, "transient.ts");
    await writeFile(transient, "temporary\n");
    await command(root, "git", "add", "transient.ts");
    await rm(transient);
    expect(await reviewFiles(root)).toEqual([]);
  });

  test("collects binary sizes for modified, removed, renamed, and new files", async () => {
    const root = await repository();
    for (const path of ["modified.bin", "removed.bin", "original.bin"]) {
      await writeFile(join(root, path), Buffer.alloc(1024));
    }
    await command(root, "git", "add", ".");
    await command(root, "git", "commit", "-m", "Binary fixtures");
    await writeFile(join(root, "modified.bin"), Buffer.alloc(2048));
    await rm(join(root, "removed.bin"));
    await command(root, "git", "mv", "original.bin", "renamed.bin");
    await writeFile(join(root, "new.bin"), Buffer.alloc(32));
    await writeFile(join(root, "staged.bin"), Buffer.alloc(64));
    await command(root, "git", "add", "staged.bin");
    const stats = await collectReviewStats(root, await collectReviewIndex(root));
    expect(Object.fromEntries(stats.map((file) => [file.path, file.binarySizes]))).toEqual({
      "modified.bin": { before: 1024, after: 2048 },
      "removed.bin": { before: 1024, after: undefined },
      "renamed.bin": { before: 1024, after: 1024 },
      "new.bin": { after: 32 },
      "staged.bin": { before: undefined, after: 64 },
    });
    expect(stats.every((file) => file.additions === 0 && file.deletions === 0)).toBe(true);
  });

  test("classifies binary changes without rendering them as text", async () => {
    const root = await repository();
    await writeFile(join(root, "asset.bin"), new Uint8Array([0, 1, 2, 3]));
    expect((await reviewFiles(root))[0]!.kind).toBe("binary");
  });

});

describe("Review comment state", () => {
  test("updates the body without changing the comment anchor or identity", () => {
    const workspaceId = `review-edit-${crypto.randomUUID()}`;
    try {
      addReviewComment(workspaceId, { path: "src/example.ts", side: "additions", startLine: 2, endLine: 3, body: "Before", snippet: "one\ntwo" });
      const original = listReviewComments(workspaceId)[0]!;

      expect(updateReviewComment(workspaceId, original.id, "After")).toBe(true);
      expect(listReviewComments(workspaceId)).toEqual([{ ...original, body: "After" }]);
      expect(updateReviewComment(workspaceId, "missing", "Ignored")).toBe(false);
    } finally {
      deleteReviewState(workspaceId);
    }
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
    return { path: comment.path, change: "modified", kind: "text", newContents: contents };
  }

  test("keeps exact anchors, remaps one exact match, and marks ambiguous matches outdated", () => {
    expect(remapReviewComment(comment, file("before\ntarget\nafter"))).toMatchObject({ startLine: 2, outdated: undefined });
    expect(remapReviewComment(comment, file("inserted\nbefore\ntarget\nafter"))).toMatchObject({ startLine: 3, endLine: 3, outdated: undefined });
    expect(remapReviewComment(comment, file("target\nbetween\ntarget"))).toMatchObject({ outdated: true });
    expect(remapReviewComment(comment, undefined)).toMatchObject({ outdated: true });
  });
});

describe("Review comment prompt", () => {
  test("formats file, line, snippet, and comment context", () => {
    const comments: ReviewCommentModel[] = [
      { id: "one", path: "apps/web/web.ts", side: "additions", startLine: 14, endLine: 14, snippet: "the selection the user made gets written here", body: "Why are we doing it like this over here" },
      { id: "two", path: "apps/web/web.tests.ts", side: "deletions", startLine: 18, endLine: 20, snippet: "the test snippet here\nwith a second line", body: "I don't think we need these tests" },
    ];

    expect(reviewCommentsPrompt(comments)).toBe(`Context: apps/web/web.ts, line 14, snippet "the selection the user made gets written here"
Comment: Why are we doing it like this over here

Context: apps/web/web.tests.ts, line 18-20, snippet "the test snippet here\\nwith a second line"
Comment: I don't think we need these tests`);
  });
});

describe("Review settings", () => {
  test("persists review diff presentation settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "atelier-review-settings-"));
    roots.push(root);
    const path = join(root, "review-settings.json");

    expect(await readReviewSettings(path)).toEqual({ mobile: "unified", desktop: "unified", highlighting: "word", overflow: "wrap" });
    await writeFile(path, `${JSON.stringify({ mobile: "split", desktop: "unified" })}\n`);
    expect(await readReviewSettings(path)).toEqual({ mobile: "split", desktop: "unified", highlighting: "word", overflow: "wrap" });
    await updateReviewSettings({ desktop: "split", highlighting: "word", overflow: "scroll" }, path);
    expect(await readReviewSettings(path)).toEqual({ mobile: "split", desktop: "split", highlighting: "word", overflow: "scroll" });

    const html = renderReviewBody("workspace 1", { phase: "ready", files: [] }, [], { mobile: "unified", desktop: "split", highlighting: "word", overflow: "scroll" });
    expect(html).toContain('data-mobile-diff-layout="unified" data-desktop-diff-layout="split" data-diff-highlighting="word" data-diff-overflow="scroll"');
    expect(html).toContain('name="review-diff-layout" value="split" aria-pressed="true">Side by side</button>');
    expect(html).toContain('name="review-diff-highlighting" value="word" aria-pressed="true">Words</button>');
    expect(html).toContain('name="review-diff-overflow" value="scroll" aria-pressed="true">Scroll</button>');
  });
});

describe("Review presentation", () => {
  test("renders explicit empty and not-git states", async () => {
    const empty = await renderReviewBody("workspace 1", { phase: "ready", files: [] }, []);
    expect(empty).toContain("No changes to review");
    expect(empty).toContain("/workspaces/workspace%201/review/refresh");

    const notGit = await renderReviewBody("workspace 1", { phase: "not-git" }, []);
    expect(notGit).toContain("No git repo in /work yet");
  });

  test("groups comments whose anchors disappeared in a collapsed pseudo-file", async () => {
    const comment: ReviewComment = { id: "comment-1", path: "src/removed.ts", side: "deletions", startLine: 4, endLine: 4, body: "Keep this behavior", snippet: "removed()", outdated: true };
    const html = await renderReviewBody("workspace 1", { phase: "ready", files: [] }, [comment]);

    expect(html).toContain('<details class="review-file" data-review-target="file" data-review-path="comments-without-anchors" data-review-comments="1" data-action="focusin->review#selectFile focusout->review#deselectFile">');
    expect(html).toContain("Comments without anchors");
    expect(html).toContain("src/removed.ts");
    expect(html).toContain("removed()");
    expect(html).toContain("Keep this behavior");
    expect(html).not.toContain("No changes to review");
    expect(html).toContain('action="/workspaces/workspace%201/review/comments/comment-1/delete"');
    expect(html).toContain('aria-label="Delete review comment"');
  });
});
