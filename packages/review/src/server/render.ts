import { preloadDiffHTML } from "@pierre/diffs/ssr";
import { domId, escapeHtml, type WorkspaceWorkViewPresentation } from "@atelier/shared";
import type { ReviewFile, ReviewSnapshot } from "./diff.ts";
import type { ReviewCommentModel } from "../model.ts";
import { reviewDiffOptions, reviewViewKey } from "../pierre.ts";
import type { ReviewComment } from "./state.ts";

export const reviewReference = { type: "review" } as const;

export function reviewBodyId(workspaceId: string): string {
  return domId("review", workspaceId, "body");
}

function jsonForHtml<Value>(value: Value): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026");
}

function commentModel(comment: ReviewComment): ReviewCommentModel {
  return { id: comment.id, path: comment.path, side: comment.side, startLine: comment.startLine, body: comment.body };
}

async function renderTextFile(file: ReviewFile, comments: ReviewComment[]): Promise<string> {
  const annotations = comments.map(commentModel);
  const pierreAnnotations = annotations.map((comment) => ({ side: comment.side, lineNumber: comment.startLine, metadata: comment }));
  const prerendered = await preloadDiffHTML({ fileDiff: file.diff!, options: reviewDiffOptions, annotations: pierreAnnotations });
  const model = { fileDiff: file.diff, comments: annotations };
  return `<div class="review-pierre-host" data-review-target="diff" data-review-path="${escapeHtml(file.path)}"><diffs-container>${prerendered}</diffs-container><script type="application/json" data-review-model>${jsonForHtml(model)}</script></div>`;
}

function renderSpecialFile(file: ReviewFile): string {
  return `<div class="review-special-file"><strong>${escapeHtml(file.detail ?? "This change cannot be rendered as text.")}</strong></div>`;
}

async function renderFile(file: ReviewFile, comments: ReviewComment[]): Promise<string> {
  const fileComments = comments.filter((comment) => comment.path === file.path);
  const body = file.kind === "text" ? await renderTextFile(file, fileComments) : renderSpecialFile(file);
  return `<details class="review-file" data-review-target="file" data-review-path="${escapeHtml(file.path)}" data-review-comments="${fileComments.length}" open>
    <summary class="action-item action-item__primary"><svg class="disclosure-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg><span class="action-item__label review-file-path" title="${escapeHtml(file.path)}"><span class="action-item__label-text">${file.previousPath ? `<span>${escapeHtml(file.previousPath)}</span><b aria-label="renamed to">→</b>` : ""}<span>${escapeHtml(file.path)}</span></span></span><span class="action-item__status review-file-meta"><span class="review-additions">+${file.additions}</span><span class="review-deletions">−${file.deletions}</span></span></summary>
    <div class="review-file-diff">${body}</div>
  </details>`;
}

function renderOutdatedComment(workspaceId: string, comment: ReviewComment): string {
  return `<article class="review-outdated-comment" data-review-comment-id="${escapeHtml(comment.id)}" data-review-comment="${escapeHtml(jsonForHtml(commentModel(comment)))}"><form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/review/comments/${encodeURIComponent(comment.id)}/delete" data-turbo="true"><button class="button secondary icon-only review-comment-close" type="submit" aria-label="Delete review comment" title="Delete review comment"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></form><div class="review-comment-content"><strong>${escapeHtml(comment.path)}</strong><pre>${escapeHtml(comment.snippet)}</pre><p>${escapeHtml(comment.body)}</p></div></article>`;
}

function summaryBar(workspaceId: string, snapshot: Extract<ReviewSnapshot, { phase: "ready" }>): string {
  return `<header class="review-toolbar">
    <div class="review-summary"><span>${snapshot.files.length} file${snapshot.files.length === 1 ? "" : "s"}</span><span class="review-additions">+${snapshot.additions}</span><span class="review-deletions">−${snapshot.deletions}</span></div>
    <form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/review/refresh" data-turbo="true" data-action="submit->review#rememberPosition"><button class="button secondary" type="submit">Refresh</button></form>
  </header>`;
}

export async function renderReviewBody(workspaceId: string, snapshot: ReviewSnapshot, comments: ReviewComment[]): Promise<string> {
  if (snapshot.phase === "not-git") {
    return `<section id="${reviewBodyId(workspaceId)}" class="review-body review-empty" data-controller="review" data-review-workspace-id-value="${escapeHtml(workspaceId)}"><div><h2>Not a git repository</h2><p>Review becomes available when this Workspace contains a Git repository.</p><form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/review/refresh" data-turbo="true"><button class="button secondary" type="submit">Refresh</button></form></div></section>`;
  }

  const currentComments = comments.filter((comment) => !comment.outdated);
  const outdated = comments.filter((comment) => comment.outdated);
  const files = await Promise.all(snapshot.files.map((file) => renderFile(file, currentComments)));
  const content = snapshot.files.length
    ? `<div class="review-files">${files.join("")}</div>`
    : `<div class="review-no-changes"><h2>No changes to review</h2><p>The working tree matches HEAD.</p></div>`;
  const outdatedHtml = outdated.length ? `<section class="review-outdated"><h2>Outdated comments</h2><p>These locations are no longer present in the current diff.</p>${outdated.map((comment) => renderOutdatedComment(workspaceId, comment)).join("")}</section>` : "";
  return `<section id="${reviewBodyId(workspaceId)}" class="review-body" data-controller="review" data-review-workspace-id-value="${escapeHtml(workspaceId)}">${summaryBar(workspaceId, snapshot)}${content}${outdatedHtml}</section>`;
}

export async function renderReviewWorkView(workspaceId: string, snapshot: ReviewSnapshot, comments: ReviewComment[]): Promise<WorkspaceWorkViewPresentation> {
  return {
    reference: reviewReference,
    sourceKey: reviewViewKey,
    label: "Review",
    kind: "contextual",
    availability: { phase: "live" },
    bodyHtml: await renderReviewBody(workspaceId, snapshot, comments),
  };
}
