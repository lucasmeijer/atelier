import type { JsonValue } from "@atelier/core";
import { createWorkspaceMetadataState } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ReviewSide } from "../model.ts";
import type { ReviewFile, ReviewSnapshot } from "./diff.ts";

const reviewCommentSchema = Type.Object({
  id: Type.String(),
  path: Type.String(),
  side: Type.Union([Type.Literal("deletions"), Type.Literal("additions")]),
  startLine: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
  body: Type.String(),
  snippet: Type.String(),
  outdated: Type.Optional(Type.Boolean()),
});
const reviewStateSchema = Type.Object({ version: Type.Literal(1), comments: Type.Array(reviewCommentSchema) });

export type ReviewComment = Static<typeof reviewCommentSchema>;
type ReviewState = Static<typeof reviewStateSchema>;

function parseReviewState(value: JsonValue): ReviewState {
  if (!Value.Check(reviewStateSchema, value)) throw new Error("invalid persisted Review state");
  return value;
}

function initialReviewState(): ReviewState {
  return { version: 1, comments: [] };
}

const states = createWorkspaceMetadataState("review.json", parseReviewState, initialReviewState);

export function listReviewComments(workspaceId: string): ReviewComment[] {
  return [...states.read(workspaceId).comments];
}

export function addReviewComment(workspaceId: string, input: { path: string; side: ReviewSide; startLine: number; endLine: number; body: string; snippet: string }): void {
  const state = states.read(workspaceId);
  state.comments.push({ id: crypto.randomUUID(), ...input });
  states.write(workspaceId, state);
}

export function deleteReviewComments(workspaceId: string, ids: readonly string[]): void {
  const selected = new Set(ids);
  const state = states.read(workspaceId);
  state.comments = state.comments.filter((comment) => !selected.has(comment.id));
  states.write(workspaceId, state);
}

function matchingStarts(lines: string[], snippetLines: string[]): number[] {
  if (snippetLines.length === 0) return [];
  const starts: number[] = [];
  for (let index = 0; index <= lines.length - snippetLines.length; index += 1) {
    if (snippetLines.every((line, offset) => lines[index + offset] === line)) starts.push(index + 1);
  }
  return starts;
}

export function remapReviewComment(comment: ReviewComment, file: ReviewFile | undefined): ReviewComment {
  const text = comment.side === "additions" ? file?.newContents : file?.oldContents;
  if (text === undefined) return { ...comment, outdated: true };
  const lines = text.split("\n");
  const snippetLines = comment.snippet.split("\n");
  const anchored = lines.slice(comment.startLine - 1, comment.endLine).join("\n");
  if (anchored === comment.snippet) return { ...comment, outdated: undefined };
  const starts = matchingStarts(lines, snippetLines);
  if (starts.length !== 1) return { ...comment, outdated: true };
  return {
    ...comment,
    startLine: starts[0]!,
    endLine: starts[0]! + snippetLines.length - 1,
    outdated: undefined,
  };
}

export function remapReviewComments(workspaceId: string, snapshot: ReviewSnapshot): ReviewComment[] {
  const state = states.read(workspaceId);
  if (snapshot.phase !== "ready") {
    state.comments = state.comments.map((comment) => ({ ...comment, outdated: true }));
  } else {
    const files = new Map(snapshot.files.map((file) => [file.path, file]));
    state.comments = state.comments.map((comment) => remapReviewComment(comment, files.get(comment.path)));
  }
  states.write(workspaceId, state);
  return [...state.comments];
}

export function reviewCommentsForPrompt(workspaceId: string, ids: readonly string[]): ReviewComment[] {
  const selected = new Set(ids);
  return states.read(workspaceId).comments.filter((comment) => selected.has(comment.id));
}

export function deleteReviewState(workspaceId: string): void {
  states.delete(workspaceId);
}
