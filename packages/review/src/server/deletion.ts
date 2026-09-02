import { createHash } from "node:crypto";
import { join } from "node:path";
import type { JsonValue } from "@atelier/core";
import { domId, escapeHtml, type WorkspaceDeletionAssessment, type WorkspaceDeletionReview } from "@atelier/shared";
import { workspaceWorkHostPath } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { collectReviewFile, collectReviewIndex, collectReviewStats, git, gitResult, type ReviewFileStats } from "./diff.ts";
import { renderChangeCounts, renderFilePath, renderFileSummary, renderReadOnlyReviewFile } from "./render.ts";

const fileSchema = Type.Object({
  path: Type.String(),
  previousPath: Type.Optional(Type.String()),
  change: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("removed")]),
  untracked: Type.Optional(Type.Literal(true)),
  additions: Type.Number(),
  deletions: Type.Number(),
});
const repositorySchema = Type.Object({
  relativePath: Type.String(),
  uncommitted: Type.Array(fileSchema),
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

async function inspect(workspaceId: string): Promise<WorkspaceDeletionAssessment> {
  const workspaceRoot = workspaceWorkHostPath(workspaceId);
  const repositories: DeletionRepository[] = [];
  const fingerprintMaterial: string[] = [];
  for (const relativePath of await repositoryPaths(workspaceRoot)) {
    const root = join(workspaceRoot, relativePath);
    const index = await collectReviewIndex(root);
    if (index.phase !== "ready") continue;
    const uncommitted = await collectReviewStats(root, index);
    if (!uncommitted.length) continue;
    const entry: DeletionRepository = {
      relativePath,
      uncommitted,
    };
    repositories.push(entry);
    const head = await gitResult(root, ["rev-parse", "--verify", "HEAD"]);
    fingerprintMaterial.push(head.exitCode === 0 ? (await git(root, ["diff", "--binary", "HEAD", "--"])).toString("base64") : "no-head");
    for (const file of entry.uncommitted.filter((candidate) => candidate.untracked)) {
      fingerprintMaterial.push(`${file.path}:${(await git(root, ["hash-object", "--no-filters", "--", file.path])).toString("utf8").trim()}`);
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
    details,
  };
  assessments.set(workspaceId, assessment);
  return assessment;
}

function fileSummary(workspaceId: string, fingerprint: string, repository: DeletionRepository, file: ReviewFileStats): string {
  const frameId = domId("deletion_review", workspaceId, fingerprint, repository.relativePath || "root", "working", file.path);
  const query = new URLSearchParams({ fingerprint, repository: repository.relativePath, path: file.path });
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
    const working = repository.uncommitted.length ? `<section class="workspace-deletion-change-group"><div class="review-files action-list">${repository.uncommitted.map((file) => fileSummary(workspaceId, assessment.fingerprint, repository, file)).join("")}</div></section>` : "";
    const repositoryHeading = repository.relativePath ? `<h2>${escapeHtml(repository.relativePath)}</h2>` : "";
    return `<section class="workspace-deletion-repository">${repositoryHeading}${working}</section>`;
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
  const repository = details.repositories.find((candidate) => candidate.relativePath === relativePath);
  const listed = repository?.uncommitted.some((file) => file.path === path);
  if (!repository || !listed) return new Response("Review file is no longer available", { status: 404 });
  const root = join(workspaceWorkHostPath(workspaceId), repository.relativePath);
  const file = await collectReviewFile(root, path);
  if (!file) return new Response("Review file is no longer available", { status: 409 });
  const frameId = domId("deletion_review", workspaceId, fingerprint, repository.relativePath || "root", "working", path);
  return new Response(await renderReadOnlyReviewFile(frameId, file), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function clearDeletionReview(workspaceId: string): void {
  assessments.delete(workspaceId);
}
