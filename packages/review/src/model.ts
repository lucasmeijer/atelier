export type ReviewSide = "deletions" | "additions";
export type ReviewDiffLayout = "unified" | "split";
export type ReviewDiffHighlighting = "line" | "word";
export type ReviewDiffOverflow = "scroll" | "wrap";
export type ReviewViewport = "mobile" | "desktop";

export interface ReviewSettings {
  mobile: ReviewDiffLayout;
  desktop: ReviewDiffLayout;
  highlighting: ReviewDiffHighlighting;
  overflow: ReviewDiffOverflow;
}

export const defaultReviewSettings = {
  mobile: "unified",
  desktop: "unified",
  highlighting: "word",
  overflow: "wrap",
} satisfies ReviewSettings;

export function isReviewDiffHighlighting(value: string | undefined): value is ReviewDiffHighlighting {
  return value === "line" || value === "word";
}

export function isReviewDiffOverflow(value: string | undefined): value is ReviewDiffOverflow {
  return value === "scroll" || value === "wrap";
}

export interface ReviewCommentModel {
  id: string;
  path: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
  body: string;
  snippet: string;
}

export function reviewCommentsPrompt(comments: readonly ReviewCommentModel[]): string {
  return comments.map((comment) => {
    const line = comment.startLine === comment.endLine ? String(comment.startLine) : `${comment.startLine}-${comment.endLine}`;
    return `Context: ${comment.path}, line ${line}, snippet ${JSON.stringify(comment.snippet)}\nComment: ${comment.body}`;
  }).join("\n\n");
}
