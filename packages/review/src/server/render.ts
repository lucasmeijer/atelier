import { actionItemHtml, type ActionItemLabel } from "@atelier/design-system/action-item";
import { activityButtonHtml } from "@atelier/design-system/activity-button";
import { copyButtonHtml } from "@atelier/design-system/copy-button";
import { Icons } from "@atelier/design-system/icons";
import { toggleHtml } from "@atelier/design-system/toggle";
import { preloadDiffHTML } from "@pierre/diffs/ssr";
import { domId, escapeHtml, turboStream, workspaceWorkViewLabelDomId, type WorkspaceWorkViewPresentation } from "@atelier/shared";
import type { ReviewFile, ReviewFileStats, ReviewFileSummary, ReviewIndex } from "./diff.ts";
import { reviewCommentsPrompt, type ReviewCommentModel, type ReviewDiffLayout } from "../model.ts";
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
  return {
    id: comment.id,
    path: comment.path,
    side: comment.side,
    startLine: comment.startLine,
    endLine: comment.endLine,
    body: comment.body,
    snippet: comment.snippet,
  };
}

async function renderTextFile(file: ReviewFile, comments: ReviewComment[]): Promise<string> {
  const annotations = comments.map(commentModel);
  const pierreAnnotations = annotations.map((comment) => ({ side: comment.side, lineNumber: comment.startLine, metadata: comment }));
  const prerendered = await preloadDiffHTML({ fileDiff: file.diff!, options: reviewDiffOptions, annotations: pierreAnnotations });
  const model = { fileDiff: file.diff, comments: annotations };
  return `<div class="atelier-pierre-host review-pierre-host" data-review-target="diff" data-review-path="${escapeHtml(file.path)}"><diffs-container><template shadowrootmode="open">${prerendered}</template></diffs-container><script type="application/json" data-review-model>${jsonForHtml(model)}</script></div>`;
}

function renderSpecialFile(file: ReviewFile): string {
  const description = file.kind === "binary"
    ? "Content preview isn’t available for binary files."
    : "This change doesn’t have a text diff to display.";
  return `<div class="review-special-file" role="note"><span class="review-special-file__visual" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3.5h6l4 4V20.5H7zM13 3.5v4h4M9.5 15.5l2-2 1.5 1.5 1.5-1.5"/></svg></span><div class="review-special-file__content"><strong>${escapeHtml(file.detail ?? "Preview unavailable")}</strong><span>${description}</span></div></div>`;
}

function renderCommentCount(count: number): string {
  if (!count) return "";
  return `<span class="review-comment-count" aria-label="${count} comment${count === 1 ? "" : "s"}">${count}</span>`;
}

function renderFileSummary(label: ActionItemLabel, metaHtml: string, title?: string): string {
  return actionItemHtml({
    kind: "single",
    leadingHtml: Icons.Disclosure,
    label: {
      ...label,
      className: "review-file-path",
      attributesHtml: title ? `title="${escapeHtml(title)}"` : undefined,
    },
    trailingHtml: `<span class="action-item__status review-file-meta">${metaHtml}</span>`,
    element: { tag: "summary", attributesHtml: 'data-linear-navigation-target="item"' },
  });
}

function anchoredCommentsFor(comments: ReviewComment[], path: string): ReviewComment[] {
  return comments.filter((comment) => comment.path === path && !comment.outdated);
}

export function reviewFileFrameId(workspaceId: string, path: string): string {
  return domId("review", workspaceId, "file", path);
}

function reviewFileStatsId(workspaceId: string, path: string): string {
  return domId("review", workspaceId, "stats", path);
}

function reviewStatsFrameId(workspaceId: string): string {
  return domId("review", workspaceId, "stats_frame");
}

function renderGitStats(workspaceId: string, file: ReviewFileSummary, counts?: Pick<ReviewFileStats, "additions" | "deletions">): string {
  const content = counts
    ? `<span class="review-additions">+${counts.additions}</span><span class="review-deletions">−${counts.deletions}</span>`
    : `<span class="status-spinner review-stats-spinner" role="status" aria-label="Loading change stats"></span>`;
  return `<span id="${reviewFileStatsId(workspaceId, file.path)}" class="review-git-stats">${content}</span>`;
}

export function renderReviewTitle(files: ReviewFileStats[]): string {
  const totals = files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 });
  return `Review <span class="review-additions">+${totals.additions}</span> <span class="review-deletions">−${totals.deletions}</span>`;
}

export function renderReviewStatsFrame(workspaceId: string, files: ReviewFileStats[]): string {
  const title = renderReviewTitle(files);
  const titleStream = turboStream("update", workspaceWorkViewLabelDomId(workspaceId, reviewViewKey), title);
  const fileStreams = files.map((file) => `<turbo-stream action="replace" target="${reviewFileStatsId(workspaceId, file.path)}"><template>${renderGitStats(workspaceId, file, file)}</template></turbo-stream>`).join("");
  return `<turbo-frame id="${reviewStatsFrameId(workspaceId)}">${titleStream}${fileStreams}</turbo-frame>`;
}

function renderFile(workspaceId: string, file: ReviewFileSummary, comments: ReviewComment[]): string {
  const fileComments = anchoredCommentsFor(comments, file.path);
  const frameId = reviewFileFrameId(workspaceId, file.path);
  const detailUrl = `/workspaces/${encodeURIComponent(workspaceId)}/review/files/${encodeURIComponent(file.path)}`;
  const label = `${file.previousPath ? `<span>${escapeHtml(file.previousPath)}</span><b aria-label="renamed to">→</b>` : ""}<span>${escapeHtml(file.path)}</span>`;
  const summary = renderFileSummary({ kind: "html", html: label }, `${renderCommentCount(fileComments.length)}${renderGitStats(workspaceId, file)}`, file.path);
  return `<details class="review-file" data-review-target="file" data-review-path="${escapeHtml(file.path)}" data-review-change="${file.change}" data-review-comments="${fileComments.length}" data-action="pointerenter->review#requestFile pointerdown->review#requestFile focusin->review#requestFile focusin->review#selectFile focusout->review#deselectFile toggle->review#requestFile">
    ${summary}
    <turbo-frame id="${frameId}" data-src="${escapeHtml(detailUrl)}"><div class="review-file-loading" role="status"><span class="status-spinner" aria-hidden="true"></span> Loading changes…</div></turbo-frame>
  </details>`;
}

export async function renderReviewFileDetails(workspaceId: string, file: ReviewFile, comments: ReviewComment[]): Promise<string> {
  const fileComments = anchoredCommentsFor(comments, file.path);
  const unanchoredComments = comments.filter((comment) => comment.outdated);
  const body = file.kind === "text" ? await renderTextFile(file, fileComments) : renderSpecialFile(file);
  const commentModels = comments.map(commentModel);
  return `<turbo-frame id="${reviewFileFrameId(workspaceId, file.path)}"><turbo-stream action="replace" target="${reviewUnanchoredId(workspaceId)}"><template>${renderUnanchoredSlot(workspaceId, unanchoredComments)}</template></turbo-stream><turbo-stream action="replace" target="${reviewCommentsModelId(workspaceId)}"><template><script id="${reviewCommentsModelId(workspaceId)}" type="application/json" data-review-comments>${jsonForHtml(commentModels)}</script></template></turbo-stream><div class="review-file-diff">${body}</div></turbo-frame>`;
}

function renderUnanchoredComment(workspaceId: string, comment: ReviewComment): string {
  return `<div class="review-unanchored-entry"><div class="review-unanchored-context"><strong>${escapeHtml(comment.path)}</strong><pre>${escapeHtml(comment.snippet)}</pre></div><article class="review-inline-comment"><form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/review/comments/${encodeURIComponent(comment.id)}/delete" data-turbo="true"><button class="button secondary icon-only review-comment-close" type="submit" aria-label="Delete review comment" title="Delete review comment">${Icons.Close}</button></form><div class="review-comment-content"><p>${escapeHtml(comment.body)}</p></div></article></div>`;
}

function reviewUnanchoredId(workspaceId: string): string {
  return domId("review", workspaceId, "unanchored");
}

function reviewCommentsModelId(workspaceId: string): string {
  return domId("review", workspaceId, "comments_model");
}

function renderUnanchoredSlot(workspaceId: string, comments: ReviewComment[]): string {
  const summary = renderFileSummary({ kind: "text", text: "Comments without anchors" }, renderCommentCount(comments.length));
  const file = comments.length ? `<details class="review-file" data-review-target="file" data-review-path="comments-without-anchors" data-review-comments="${comments.length}" data-action="focusin->review#selectFile focusout->review#deselectFile">
    ${summary}
    <div class="review-file-diff review-unanchored-comments">${comments.map((comment) => renderUnanchoredComment(workspaceId, comment)).join("")}</div>
  </details>` : "";
  return `<div id="${reviewUnanchoredId(workspaceId)}">${file}</div>`;
}

function iconButton(label: string, action: string, iconHtml: string): string {
  return `<button class="button secondary icon-only" type="button" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" data-action="${escapeHtml(action)}">${iconHtml}</button>`;
}

function refreshForm(workspaceId: string, caption = ""): string {
  const content = {
    variant: "secondary" as const,
    type: "submit" as const,
    state: "initial" as const,
    initialContent: { kind: "html" as const, html: `${Icons.Refresh}${caption}` },
    activeContent: { kind: "html" as const, html: `${Icons.Refresh}${caption ? "Refreshing…" : ""}` },
  };
  const button = caption
    ? activityButtonHtml(content)
    : activityButtonHtml({ ...content, iconOnly: true, initialLabel: "Refresh review", activeLabel: "Refreshing review" });
  return `<form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/review/refresh" data-turbo="true" data-action="submit->review#updateRefreshState turbo:submit-end->review#updateRefreshState">${button}</form>`;
}

function toolbar(workspaceId: string, comments: ReviewComment[], diffLayout: ReviewDiffLayout): string {
  const commentsDisabled = comments.length === 0 ? " disabled" : "";
  const collapse = iconButton("Collapse all files", "review#collapseAll", Icons.CollapseAll);
  const expand = iconButton("Expand all files", "review#expandAll", Icons.ExpandAll);
  const copyButton = copyButtonHtml({
    label: "Copy review comments to clipboard",
    disabled: comments.length === 0,
  });
  const diffLayoutToggle = toggleHtml({
    variant: "text-subtle",
    label: "Diff layout",
    name: "review-diff-layout",
    value: diffLayout,
    form: { action: "/review/settings/diff-layout", dataAction: "change->review#setDiffLayout" },
    options: [{ label: "Unified", value: "unified" }, { label: "Side by side", value: "split" }],
  });
  const diffHighlighting = toggleHtml({
    variant: "text-subtle",
    label: "Diff highlighting",
    name: "review-word-diff",
    value: "false",
    element: { dataAction: "change->review#setWordDiff" },
    options: [{ label: "Lines", value: "false" }, { label: "Words", value: "true" }],
  });
  const longLines = toggleHtml({
    variant: "text-subtle",
    label: "Long lines",
    name: "review-line-wrapping",
    value: "true",
    element: { dataAction: "change->review#setLineWrapping" },
    options: [{ label: "Scroll", value: "false" }, { label: "Wrap", value: "true" }],
  });
  return `<header class="review-toolbar">
    <div class="review-toolbar-actions button-group copy-region">
      <button class="button secondary" type="button" title="Copy review comments into composer" data-action="click->review#copyCommentsToComposer"${commentsDisabled}>Copy into composer</button>
      ${copyButton}
      <form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/review/comments/delete" data-turbo="true"><button class="button danger icon-only" type="submit" aria-label="Delete all review comments" title="Delete all review comments"${commentsDisabled}>${Icons.Trash}</button></form>
      ${refreshForm(workspaceId)}
      ${collapse}${expand}
      <div class="review-display-toggles"><span class="review-layout-status" data-review-target="layoutStatus" role="status" aria-live="polite" hidden><span class="status-spinner" aria-hidden="true"></span><span data-review-target="layoutStatusText"></span></span>${diffLayoutToggle}${diffHighlighting}${longLines}</div>
      <span data-copy-source hidden>${escapeHtml(reviewCommentsPrompt(comments))}</span>
    </div>
  </header>`;
}

export function renderReviewBody(workspaceId: string, index: ReviewIndex, comments: ReviewComment[], diffLayout: ReviewDiffLayout = "unified"): string {
  if (index.phase === "not-git") {
    return `<section id="${reviewBodyId(workspaceId)}" class="review-body review-empty" data-controller="review" data-review-workspace-id-value="${escapeHtml(workspaceId)}"><div><h2>Not a git repository</h2><p>Review becomes available when this Workspace contains a Git repository.</p>${refreshForm(workspaceId, "Refresh")}</div></section>`;
  }

  const unanchoredComments = comments.filter((comment) => comment.outdated);
  const renderedFiles = index.files.map((file) => renderFile(workspaceId, file, comments));
  const content = renderedFiles.length || unanchoredComments.length
    ? `<div class="review-files action-list" data-controller="linear-navigation" data-action="keydown->review#changeFileDisclosure">${renderedFiles.join("")}${renderUnanchoredSlot(workspaceId, unanchoredComments)}</div>`
    : `<div class="review-no-changes"><h2>No changes to review</h2><p>The working tree matches HEAD.</p></div>`;
  const commentModels = comments.map(commentModel);
  const statsUrl = `/workspaces/${encodeURIComponent(workspaceId)}/review/stats`;
  return `<section id="${reviewBodyId(workspaceId)}" class="review-body" data-controller="review" data-review-workspace-id-value="${escapeHtml(workspaceId)}" data-review-diff-layout="${diffLayout}">${toolbar(workspaceId, comments, diffLayout)}${content}<turbo-frame id="${reviewStatsFrameId(workspaceId)}" src="${escapeHtml(statsUrl)}"></turbo-frame><script id="${reviewCommentsModelId(workspaceId)}" type="application/json" data-review-comments>${jsonForHtml(commentModels)}</script></section>`;
}

export const reviewWorkViewPresentation: WorkspaceWorkViewPresentation = {
  reference: reviewReference,
  sourceKey: reviewViewKey,
  label: "Review",
  kind: "contextual",
  availability: { phase: "live" },
};
