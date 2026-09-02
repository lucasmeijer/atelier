export type ReviewSide = "deletions" | "additions";
export type ReviewDiffLayout = "unified" | "split";

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
