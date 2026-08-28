export type ReviewSide = "deletions" | "additions";

export interface ReviewCommentModel {
  id: string;
  path: string;
  side: ReviewSide;
  startLine: number;
  body: string;
}
