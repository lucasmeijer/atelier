import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewCommentsPrompt, type ReviewCommentModel } from "../src/model.ts";
import { collectReviewFile, collectReviewIndex, collectReviewStats, type ReviewFile, type ReviewFileStats } from "../src/server/diff.ts";
import { renderReviewBody, renderReviewFileDetails, renderReviewStatsFrame, reviewWorkViewPresentation } from "../src/server/render.ts";
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

describe("Review presentation", () => {
  test("describes the Work view without collecting or rendering its diff", () => {
    expect(reviewWorkViewPresentation).toEqual({
      reference: { type: "review" },
      sourceKey: "review:workspace",
      label: "Review",
      kind: "contextual",
      availability: { phase: "live" },
    });
  });

  test("renders explicit empty and not-git states", async () => {
    const empty = await renderReviewBody("workspace 1", { phase: "ready", files: [] }, []);
    expect(empty).toContain("No changes to review");
    expect(empty).toContain("/workspaces/workspace%201/review/refresh");

    const notGit = await renderReviewBody("workspace 1", { phase: "not-git" }, []);
    expect(notGit).toContain("Not a git repository");
  });

  test("defers the server-rendered diff until its file frame is requested", async () => {
    const root = await repository();
    await writeFile(join(root, "changed.ts"), "const after = true;\n");
    const index = await collectReviewIndex(root);
    if (index.phase !== "ready") throw new Error("expected ready review");
    const file = await collectReviewFile(root, "changed.ts");
    if (!file) throw new Error("expected review file");

    const body = renderReviewBody("workspace 1", index, []);
    expect(body).toContain('data-src="/workspaces/workspace%201/review/files/changed.ts"');
    expect(body).toContain('src="/workspaces/workspace%201/review/stats"');
    expect(body).toContain('aria-label="Loading change stats"');
    expect(body).not.toContain("<diffs-container>");
    expect(body).not.toContain("review-additions");

    const stats = renderReviewStatsFrame("workspace 1", await collectReviewStats(root, index));
    expect(stats).toContain("review-additions\">+1");
    expect(stats).not.toContain("Loading change stats");

    const details = await renderReviewFileDetails("workspace 1", file, []);
    expect(details).toMatch(/<diffs-container><template shadowrootmode="open">[\s\S]*<style data-core-css="">[\s\S]*<\/template><\/diffs-container>/);
    expect(details).not.toContain("review-additions");
  });

  test("renders file grouping collapsed by default with explicit review comment actions", async () => {
    const comment: ReviewComment = { id: "comment-1", path: "src/example.ts", side: "additions", startLine: 2, endLine: 2, body: "Keep this lazy", snippet: "target" };
    const file: ReviewFile = { path: "src/example.ts", change: "modified", kind: "binary", detail: "Binary file changed" };
    const html = renderReviewBody("workspace 1", { phase: "ready", files: [file] }, [comment]);

    expect(html).toContain('class="review-files action-list"');
    expect(html).toContain('<details class="review-file" data-review-target="file" data-review-path="src/example.ts" data-review-change="modified" data-review-comments="1" data-action="pointerenter->review#requestFile pointerdown->review#requestFile focusin->review#requestFile toggle->review#requestFile">');
    expect([...html.matchAll(/<details class="review-file"[^>]*>/g)].every(([details]) => !details.includes(" open"))).toBe(true);
    expect(html).toContain('data-src="/workspaces/workspace%201/review/files/src%2Fexample.ts"');
    expect(html).not.toContain("Binary file changed");
    expect(html).toContain("Copy into composer");
    expect(html).toContain('data-action="click->review#copyCommentsToComposer"');
    expect(html).toContain('class="button secondary icon-only copy-button"');
    expect(html).toContain('aria-label="Copy review comments to clipboard"');
    expect(html).toContain('action="/workspaces/workspace%201/review/comments/delete"');
    expect(html).toContain('aria-label="Delete all review comments"');
    expect(html).toContain('aria-label="Refresh review"');
    expect(html).toContain('aria-label="Collapse all files"');
    expect(html).toContain('aria-label="Expand all files"');
    expect(html).toContain('title="Toggle per-word diff highlighting" aria-pressed="false" data-action="click->review#toggleWordDiff">Word diff</button>');
    expect(html).toContain('title="Toggle long line wrapping" aria-pressed="true" data-action="click->review#toggleLineWrapping">Wrap lines</button>');
    expect(html.indexOf(">Word diff</button>")).toBeLessThan(html.indexOf(">Wrap lines</button>"));
    expect(html).toContain('<span class="review-comment-count" aria-label="1 comment">1</span>');
    const details = await renderReviewFileDetails("workspace 1", file, [comment]);
    expect(details).toContain('role="note"');
    expect(details).toContain("Binary file changed");
    expect(details).toContain("Content preview isn’t available for binary files.");
    expect(html.indexOf("Copy into composer")).toBeLessThan(html.indexOf('aria-label="Copy review comments to clipboard"'));
    expect(html.indexOf('aria-label="Copy review comments to clipboard"')).toBeLessThan(html.indexOf('aria-label="Delete all review comments"'));
    expect(html.indexOf('aria-label="Delete all review comments"')).toBeLessThan(html.indexOf('aria-label="Refresh review"'));
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect([...header.matchAll(/<button\b[^>]*>/g)].every(([button]) => button.includes('title="'))).toBe(true);
    expect(html).not.toContain('aria-label="Review totals"');
    expect(html).not.toContain('name="reviewComment"');
  });

  test("loads zero deletion stats for added files without an untracked label", () => {
    const files: ReviewFile[] = [
      { path: "changed.ts", change: "modified", kind: "binary" },
      { path: "new.ts", change: "added", kind: "binary" },
    ];
    const fileStats: ReviewFileStats[] = [
      { path: "changed.ts", change: "modified", additions: 1, deletions: 1 },
      { path: "new.ts", change: "added", untracked: true, additions: 1, deletions: 0 },
    ];

    const html = renderReviewBody("workspace 1", { phase: "ready", files }, []);
    expect(html.match(/Loading change stats/g)).toHaveLength(2);
    expect(html).not.toContain("Untracked");
    expect(html).not.toContain("review-additions");

    const stats = renderReviewStatsFrame("workspace 1", fileStats);
    expect(stats).toContain('<span class="review-deletions">−1</span>');
    expect(stats).toContain('<span class="review-deletions">−0</span>');
  });

  test("groups comments whose anchors disappeared in an open pseudo-file", async () => {
    const comment: ReviewComment = { id: "comment-1", path: "src/removed.ts", side: "deletions", startLine: 4, endLine: 4, body: "Keep this behavior", snippet: "removed()", outdated: true };
    const html = await renderReviewBody("workspace 1", { phase: "ready", files: [] }, [comment]);

    expect(html).toContain('<details class="review-file" data-review-target="file" data-review-path="comments-without-anchors" data-review-comments="1" open>');
    expect(html).toContain("Comments without anchors");
    expect(html).toContain("src/removed.ts");
    expect(html).toContain("removed()");
    expect(html).toContain("Keep this behavior");
    expect(html).not.toContain("No changes to review");
    expect(html).toContain('action="/workspaces/workspace%201/review/comments/comment-1/delete"');
    expect(html).toContain('aria-label="Delete review comment"');
  });
});
