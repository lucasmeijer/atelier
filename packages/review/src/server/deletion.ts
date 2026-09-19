import { createHash } from "node:crypto";
import { join } from "node:path";
import { collectUnpushedCommits, type UnpushedCommit } from "@atelier/core";
import { domId, escapeHtml, type WorkspaceDeletionAssessment, type WorkspaceDeletionReview } from "@atelier/shared";
import { workspaceWorkHostPath } from "@atelier/workspace";
import { collectCommitReviewFile, collectCommitReviewStats, collectReviewFile, collectReviewIndex, collectReviewStats, git, gitResult, type ReviewFileStats } from "./diff.ts";
import { renderFileStats, renderFileSummary, renderReadOnlyReviewFile } from "./render.ts";

type DeletionRepository = {
  relativePath: string;
  uncommitted: ReviewFileStats[];
  unpushedCommits: UnpushedCommit[];
};
type DeletionAssessment = {
  status: "blocked";
  fingerprint: string;
  details: { repositories: DeletionRepository[] };
};

const assessments = new Map<string, DeletionAssessment>();

async function repositoryPaths(root: string): Promise<string[]> {
  const inside = await gitResult(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.exitCode !== 0 || inside.stdout.toString("utf8").trim() !== "true") return [];
  const submodules = await gitResult(root, ["submodule", "foreach", "--quiet", "--recursive", "printf '%s\\0' \"$displaypath\""]);
  if (submodules.exitCode !== 0) throw new Error(submodules.stderr || "could not enumerate workspace submodules");
  return ["", ...submodules.stdout.toString("utf8").split("\0").filter(Boolean)];
}

async function inspect(workspaceId: string): Promise<WorkspaceDeletionAssessment> {
  const workspaceRoot = workspaceWorkHostPath(workspaceId);
  const repositories: DeletionRepository[] = [];
  const fingerprintMaterial: string[] = [];
  for (const relativePath of await repositoryPaths(workspaceRoot)) {
    const root = join(workspaceRoot, relativePath);
    const index = await collectReviewIndex(root);
    if (index.phase !== "ready") continue;
    const uncommitted = await collectReviewStats(root, index);
    const unpushedCommits = await collectUnpushedCommits((args) => gitResult(root, args));
    if (!uncommitted.length && !unpushedCommits.length) continue;
    repositories.push({ relativePath, uncommitted, unpushedCommits });
    if (!uncommitted.length) continue;
    const head = await gitResult(root, ["rev-parse", "--verify", "HEAD"]);
    fingerprintMaterial.push(head.exitCode === 0 ? (await git(root, ["diff", "--binary", "HEAD", "--"])).toString("base64") : "no-head");
    for (const file of uncommitted.filter((candidate) => candidate.untracked)) {
      fingerprintMaterial.push(`${file.path}:${(await git(root, ["hash-object", "--no-filters", "--", file.path])).toString("utf8").trim()}`);
    }
  }
  if (!repositories.length) {
    assessments.delete(workspaceId);
    return { status: "clear" };
  }
  const details = { repositories };
  const fingerprint = createHash("sha256").update(JSON.stringify(details)).update(fingerprintMaterial.join("\0")).digest("hex");
  const assessment: DeletionAssessment = {
    status: "blocked",
    fingerprint,
    details,
  };
  assessments.set(workspaceId, assessment);
  return assessment;
}

function fileFrameId(workspaceId: string, fingerprint: string, repository: string, path: string, commit = ""): string {
  return domId("deletion_review", workspaceId, fingerprint, repository || "root", commit || "working", path);
}

function commitFrameId(workspaceId: string, fingerprint: string, repository: string, commit: string): string {
  return domId("deletion_commit", workspaceId, fingerprint, repository || "root", commit);
}

function lazyFrame(frameId: string, url: string): string {
  return `<turbo-frame id="${frameId}" data-src="${escapeHtml(url)}"><div class="review-file-loading" role="status"><span class="status-spinner" aria-hidden="true"></span> Loading changes…</div></turbo-frame>`;
}

function fileSummary(workspaceId: string, fingerprint: string, repository: string, file: ReviewFileStats, commit = ""): string {
  const frameId = fileFrameId(workspaceId, fingerprint, repository, file.path, commit);
  const query = new URLSearchParams({ fingerprint, repository, path: file.path, commit });
  const summary = renderFileSummary(
    { kind: "text", text: file.path },
    `<span class="review-git-stats">${renderFileStats(file)}</span>`,
    file.path,
  );
  return `<details class="review-file" data-action="toggle->deletion-review#requestFile">${summary}${lazyFrame(frameId, `/workspaces/${encodeURIComponent(workspaceId)}/review/deletion/file?${query}`)}</details>`;
}

function fileList(workspaceId: string, fingerprint: string, repository: string, files: ReviewFileStats[], commit = ""): string {
  return `<div class="review-files action-list">${files.map((file) => fileSummary(workspaceId, fingerprint, repository, file, commit)).join("")}</div>`;
}

function commitSummary(workspaceId: string, fingerprint: string, repository: string, commit: UnpushedCommit): string {
  const summary = renderFileSummary({ kind: "text", text: commit.subject }, `<code title="${escapeHtml(commit.hash)}">${escapeHtml(commit.hash.slice(0, 12))}</code>`);
  const query = new URLSearchParams({ fingerprint, repository, commit: commit.hash });
  const frameId = commitFrameId(workspaceId, fingerprint, repository, commit.hash);
  return `<details class="review-file workspace-deletion-change-group" data-action="toggle->deletion-review#requestFile">${summary}${lazyFrame(frameId, `/workspaces/${encodeURIComponent(workspaceId)}/review/deletion/commit?${query}`)}</details>`;
}

function renderEvidence(workspaceId: string): string {
  const assessment = assessments.get(workspaceId);
  if (!assessment) throw new Error("Deletion review assessment is no longer current");
  return `<div data-controller="deletion-review"><p>You might loose:</p>${assessment.details.repositories.map((repository) => {
    const { fingerprint } = assessment;
    const working = repository.uncommitted.length ? `<details class="review-file workspace-deletion-change-group" open>${renderFileSummary({ kind: "text", text: "Uncommitted changes" }, "")}${fileList(workspaceId, fingerprint, repository.relativePath, repository.uncommitted)}</details>` : "";
    const commits = repository.unpushedCommits.length ? `<div class="action-list">${repository.unpushedCommits.map((commit) => commitSummary(workspaceId, fingerprint, repository.relativePath, commit)).join("")}</div>` : "";
    const repositoryHeading = repository.relativePath ? `<h2>${escapeHtml(repository.relativePath)}</h2>` : "";
    return `<section class="workspace-deletion-repository">${repositoryHeading}${working}${commits}</section>`;
  }).join("")}</div>`;
}

export const reviewDeletionReview: WorkspaceDeletionReview = { inspect, renderEvidence };

function reviewRequest(workspaceId: string, url: URL) {
  const assessment = assessments.get(workspaceId);
  const fingerprint = url.searchParams.get("fingerprint") ?? "";
  if (!assessment || assessment.fingerprint !== fingerprint) return new Response("Deletion assessment is no longer current", { status: 409 });
  const relativePath = url.searchParams.get("repository") ?? "";
  const repository = assessment.details.repositories.find((candidate) => candidate.relativePath === relativePath);
  if (!repository) return new Response("Review repository is no longer available", { status: 404 });
  const commit = url.searchParams.get("commit") ?? "";
  if (commit && !repository.unpushedCommits.some((candidate) => candidate.hash === commit)) return new Response("Review commit is no longer available", { status: 404 });
  return { fingerprint, repository, commit, root: join(workspaceWorkHostPath(workspaceId), relativePath) };
}

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function deletionReviewCommitResponse(workspaceId: string, url: URL): Promise<Response> {
  const context = reviewRequest(workspaceId, url);
  if (context instanceof Response) return context;
  const { fingerprint, repository, commit, root } = context;
  if (!commit) return new Response("Review commit is required", { status: 400 });
  const files = await collectCommitReviewStats(root, commit);
  const frameId = commitFrameId(workspaceId, fingerprint, repository.relativePath, commit);
  const body = files.length ? fileList(workspaceId, fingerprint, repository.relativePath, files, commit) : '<p class="workspace-deletion-empty">This commit has no file changes.</p>';
  return htmlResponse(`<turbo-frame id="${frameId}">${body}</turbo-frame>`);
}

export async function deletionReviewFileResponse(workspaceId: string, url: URL): Promise<Response> {
  const context = reviewRequest(workspaceId, url);
  if (context instanceof Response) return context;
  const { fingerprint, repository, commit, root } = context;
  const path = url.searchParams.get("path") ?? "";
  if (!commit && !repository.uncommitted.some((file) => file.path === path)) return new Response("Review file is no longer available", { status: 404 });
  const file = commit ? await collectCommitReviewFile(root, commit, path) : await collectReviewFile(root, path);
  if (!file) return new Response("Review file is no longer available", { status: commit ? 404 : 409 });
  const frameId = fileFrameId(workspaceId, fingerprint, repository.relativePath, path, commit);
  return htmlResponse(await renderReadOnlyReviewFile(frameId, file));
}

export function clearDeletionReview(workspaceId: string): void {
  assessments.delete(workspaceId);
}
