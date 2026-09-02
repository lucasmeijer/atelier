import { createHash } from "node:crypto";
import { join } from "node:path";
import type { JsonValue } from "@atelier/core";
import { domId, escapeHtml, type WorkspaceDeletionAssessment, type WorkspaceDeletionReview } from "@atelier/shared";
import { workspaceWorkHostPath } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { collectCommitFile, collectCommitStats, collectReviewFile, collectReviewIndex, collectReviewStats, git, gitResult, type ReviewFileStats } from "./diff.ts";
import { renderChangeCounts, renderFilePath, renderFileSummary, renderReadOnlyReviewFile } from "./render.ts";

const fileSchema = Type.Object({
  path: Type.String(),
  previousPath: Type.Optional(Type.String()),
  change: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("removed")]),
  untracked: Type.Optional(Type.Literal(true)),
  additions: Type.Number(),
  deletions: Type.Number(),
});
const commitSchema = Type.Object({
  hash: Type.String(),
  subject: Type.String(),
  files: Type.Array(fileSchema),
});
const repositorySchema = Type.Object({
  relativePath: Type.String(),
  uncommitted: Type.Array(fileSchema),
  outgoingCommits: Type.Array(commitSchema),
  noUpstream: Type.Boolean(),
  verificationError: Type.Optional(Type.String()),
});
const deletionDetailsSchema = Type.Object({ repositories: Type.Array(repositorySchema) });
type DeletionDetails = Static<typeof deletionDetailsSchema>;
type DeletionRepository = DeletionDetails["repositories"][number];

const assessments = new Map<string, Extract<WorkspaceDeletionAssessment, { status: "blocked" }>>();

async function repositoryPaths(root: string): Promise<string[]> {
  const inside = await gitResult(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.exitCode !== 0 || inside.stdout.toString("utf8").trim() !== "true") return [];
  const submodules = await gitResult(root, ["submodule", "foreach", "--quiet", "--recursive", "printf '%s\\0' \"$displaypath\""]);
  if (submodules.exitCode !== 0) throw new Error(submodules.stderr || "could not enumerate workspace submodules");
  return ["", ...submodules.stdout.toString("utf8").split("\0").filter(Boolean)];
}

async function outgoingCommits(root: string): Promise<{ commits: Array<{ hash: string; subject: string; files: ReviewFileStats[] }>; noUpstream: boolean }> {
  const head = await gitResult(root, ["rev-parse", "--verify", "HEAD"]);
  if (head.exitCode !== 0) return { commits: [], noUpstream: false };
  const upstream = await gitResult(root, ["rev-parse", "--verify", "@{upstream}"]);
  const noUpstream = upstream.exitCode !== 0;
  const args = upstream.exitCode === 0
    ? ["log", "--format=%H%x1f%s%x1e", "@{upstream}..HEAD"]
    : ["log", "--format=%H%x1f%s%x1e", "HEAD", "--not", "--remotes"];
  const output = (await git(root, args)).toString("utf8");
  const commits = await Promise.all(output.split("\x1e").map((record) => record.trim()).filter(Boolean).map(async (record) => {
    const separator = record.indexOf("\x1f");
    const hash = separator === -1 ? record : record.slice(0, separator);
    const subject = separator === -1 ? "" : record.slice(separator + 1);
    return { hash, subject, files: await collectCommitStats(root, hash) };
  }));
  return { commits, noUpstream };
}

async function inspect(workspaceId: string): Promise<WorkspaceDeletionAssessment> {
  const workspaceRoot = workspaceWorkHostPath(workspaceId);
  const repositories: DeletionRepository[] = [];
  const fingerprintMaterial: string[] = [];
  for (const relativePath of await repositoryPaths(workspaceRoot)) {
    const root = join(workspaceRoot, relativePath);
    const index = await collectReviewIndex(root);
    if (index.phase !== "ready") continue;
    const fetch = await gitResult(root, ["fetch", "--quiet"]);
    const outgoing = await outgoingCommits(root);
    const entry: DeletionRepository = {
      relativePath,
      uncommitted: await collectReviewStats(root, index),
      outgoingCommits: outgoing.commits,
      noUpstream: outgoing.noUpstream,
    };
    if (fetch.exitCode !== 0) entry.verificationError = fetch.stderr || "Could not fetch remote refs";
    if (entry.uncommitted.length || entry.outgoingCommits.length || entry.verificationError) {
      repositories.push(entry);
      const head = await gitResult(root, ["rev-parse", "--verify", "HEAD"]);
      fingerprintMaterial.push(head.exitCode === 0 ? (await git(root, ["diff", "--binary", "HEAD", "--"])).toString("base64") : "no-head");
      for (const file of entry.uncommitted.filter((candidate) => candidate.untracked)) {
        fingerprintMaterial.push(`${file.path}:${(await git(root, ["hash-object", "--no-filters", "--", file.path])).toString("utf8").trim()}`);
      }
    }
  }
  if (!repositories.length) {
    assessments.delete(workspaceId);
    return { status: "clear" };
  }
  const details: DeletionDetails = { repositories };
  const fingerprint = createHash("sha256").update(JSON.stringify(details)).update(fingerprintMaterial.join("\0")).digest("hex");
  const assessment: Extract<WorkspaceDeletionAssessment, { status: "blocked" }> = {
    status: "blocked",
    fingerprint,
    verification: repositories.some((repository) => repository.verificationError) ? "incomplete" : "verified",
    details,
  };
  assessments.set(workspaceId, assessment);
  return assessment;
}

function fileSummary(workspaceId: string, fingerprint: string, repository: DeletionRepository, file: ReviewFileStats, commit?: string): string {
  const frameId = domId("deletion_review", workspaceId, fingerprint, repository.relativePath || "root", commit ?? "working", file.path);
  const query = new URLSearchParams({ fingerprint, repository: repository.relativePath, path: file.path });
  if (commit) query.set("commit", commit);
  const summary = renderFileSummary(
    { kind: "html", html: renderFilePath(file.path) },
    `<span class="review-git-stats">${renderChangeCounts(file)}</span>`,
    file.path,
  );
  return `<details class="review-file" data-action="pointerenter->deletion-review#requestFile pointerdown->deletion-review#requestFile focusin->deletion-review#requestFile toggle->deletion-review#requestFile">${summary}<turbo-frame id="${frameId}" data-src="/workspaces/${encodeURIComponent(workspaceId)}/review/deletion/file?${escapeHtml(query.toString())}"><div class="review-file-loading" role="status"><span class="status-spinner" aria-hidden="true"></span> Loading changes…</div></turbo-frame></details>`;
}

function renderEvidence(workspaceId: string, value: JsonValue): string {
  const details = Value.Parse(deletionDetailsSchema, value);
  const assessment = assessments.get(workspaceId);
  if (!assessment) throw new Error("Deletion review assessment is no longer current");
  return `<div data-controller="deletion-review">${details.repositories.map((repository) => {
    const error = repository.verificationError ? `<div class="workspace-deletion-verification-error" role="alert"><strong>Remote verification failed</strong><p>${escapeHtml(repository.verificationError)}</p><p>Local changes are shown, but Atelier could not verify whether every commit exists remotely.</p></div>` : "";
    const working = repository.uncommitted.length ? `<section class="workspace-deletion-change-group"><div class="review-files action-list">${repository.uncommitted.map((file) => fileSummary(workspaceId, assessment.fingerprint, repository, file)).join("")}</div></section>` : "";
    const commits = repository.outgoingCommits.length ? `<section class="workspace-deletion-change-group"><h3>Unpushed commits</h3>${repository.noUpstream ? `<p class="workspace-deletion-note">No upstream branch is configured; these commits were not found on any remote ref.</p>` : ""}<div class="workspace-deletion-commits">${repository.outgoingCommits.map((commit) => `<details class="workspace-deletion-commit"><summary><code>${escapeHtml(commit.hash.slice(0, 12))}</code><span>${escapeHtml(commit.subject)}</span><span>${commit.files.length} file${commit.files.length === 1 ? "" : "s"}</span></summary><div class="review-files action-list">${commit.files.map((file) => fileSummary(workspaceId, assessment.fingerprint, repository, file, commit.hash)).join("")}</div></details>`).join("")}</div></section>` : "";
    const repositoryHeading = repository.relativePath ? `<h2>${escapeHtml(repository.relativePath)}</h2>` : "";
    return `<section class="workspace-deletion-repository">${repositoryHeading}${error}${working}${commits}</section>`;
  }).join("")}</div>`;
}

export const reviewDeletionReview: WorkspaceDeletionReview = { inspect, renderEvidence };

export async function deletionReviewFileResponse(workspaceId: string, url: URL): Promise<Response> {
  const assessment = assessments.get(workspaceId);
  const fingerprint = url.searchParams.get("fingerprint") ?? "";
  if (!assessment || assessment.fingerprint !== fingerprint) return new Response("Deletion assessment is no longer current", { status: 409 });
  const details = Value.Parse(deletionDetailsSchema, assessment.details);
  const relativePath = url.searchParams.get("repository") ?? "";
  const path = url.searchParams.get("path") ?? "";
  const commit = url.searchParams.get("commit") ?? undefined;
  const repository = details.repositories.find((candidate) => candidate.relativePath === relativePath);
  const listed = commit
    ? repository?.outgoingCommits.find((candidate) => candidate.hash === commit)?.files.some((file) => file.path === path)
    : repository?.uncommitted.some((file) => file.path === path);
  if (!repository || !listed) return new Response("Review file is no longer available", { status: 404 });
  const root = join(workspaceWorkHostPath(workspaceId), repository.relativePath);
  const file = commit ? await collectCommitFile(root, commit, path) : await collectReviewFile(root, path);
  if (!file) return new Response("Review file is no longer available", { status: 409 });
  const frameId = domId("deletion_review", workspaceId, fingerprint, repository.relativePath || "root", commit ?? "working", path);
  return new Response(await renderReadOnlyReviewFile(frameId, file), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function clearDeletionReview(workspaceId: string): void {
  assessments.delete(workspaceId);
}
