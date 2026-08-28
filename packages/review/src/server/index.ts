import type { JsonValue } from "@atelier/core";
import { turboStream, turboStreamResponse, type WorkspaceModule } from "@atelier/shared";
import { workspaceWorkHostPath } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ReviewSide } from "../model.ts";
import { collectReviewSnapshot, reviewSnippet, type ReviewSnapshot } from "./diff.ts";
import { renderReviewBody, renderReviewWorkView, reviewBodyId, reviewReference } from "./render.ts";
import { addReviewComment, deleteReviewComments, deleteReviewState, listReviewComments, remapReviewComments, reviewCommentsForPrompt, type ReviewComment } from "./state.ts";

const reviewReferenceSchema = Type.Object({ type: Type.Literal("review") });
type ReviewReference = Static<typeof reviewReferenceSchema>;
const snapshots = new Map<string, ReviewSnapshot>();

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

async function refresh(workspaceId: string): Promise<{ snapshot: ReviewSnapshot; comments: ReviewComment[] }> {
  const snapshot = await collectReviewSnapshot(workspaceWorkHostPath(workspaceId));
  snapshots.set(workspaceId, snapshot);
  return { snapshot, comments: remapReviewComments(workspaceId, snapshot) };
}

async function current(workspaceId: string): Promise<{ snapshot: ReviewSnapshot; comments: ReviewComment[] }> {
  const snapshot = snapshots.get(workspaceId);
  return snapshot ? { snapshot, comments: listReviewComments(workspaceId) } : await refresh(workspaceId);
}

async function bodyStream(workspaceId: string, snapshot: ReviewSnapshot, comments: ReviewComment[]): Promise<string> {
  return turboStream("replace", reviewBodyId(workspaceId), await renderReviewBody(workspaceId, snapshot, comments));
}

async function refreshedResponse(workspaceId: string): Promise<Response> {
  const { snapshot, comments } = await refresh(workspaceId);
  return turboStreamResponse(await bodyStream(workspaceId, snapshot, comments));
}

function positiveLine(value: FormDataEntryValue | null): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function createComment(workspaceId: string, request: Request): Promise<Response> {
  const form = await request.formData();
  const path = String(form.get("path") ?? "");
  const sideValue = String(form.get("side") ?? "");
  const side: ReviewSide | undefined = sideValue === "deletions" || sideValue === "additions" ? sideValue : undefined;
  const startLine = positiveLine(form.get("startLine"));
  const endLine = positiveLine(form.get("endLine"));
  const body = String(form.get("body") ?? "").trim();
  if (!path || !side || !startLine || !endLine || endLine < startLine || !body || body.length > 20_000) return textResponse("Invalid review comment", 422);
  const { snapshot } = await refresh(workspaceId);
  const file = snapshot.phase === "ready" ? snapshot.files.find((candidate) => candidate.path === path && candidate.kind === "text") : undefined;
  if (!file) return textResponse("Review file is no longer available", 409);
  const snippet = reviewSnippet(file, side, startLine, endLine);
  if (!snippet && startLine !== 1) return textResponse("Review line is no longer available", 409);
  addReviewComment(workspaceId, { path, side, startLine, endLine, body, snippet });
  return turboStreamResponse(await bodyStream(workspaceId, snapshot, listReviewComments(workspaceId)));
}

function promptSection(comments: ReviewComment[]): string {
  if (!comments.length) return "";
  const entries = comments.map((comment, index) => {
    const side = comment.side === "additions" ? "new" : "old";
    const range = comment.startLine === comment.endLine ? `${comment.startLine}` : `${comment.startLine}-${comment.endLine}`;
    const quote = comment.snippet.split("\n").map((line) => `    ${line}`).join("\n");
    return `${index + 1}. ${comment.path} (${side} lines ${range})\n\n${quote}\n\n   Review comment: ${comment.body}`;
  });
  return `Please address these review comments:\n\n${entries.join("\n\n")}`;
}

export const reviewWorkspaceModule: WorkspaceModule = {
  id: "review",
  workViews: [{
    type: "review",
    parseReference(value: JsonValue) {
      if (!Value.Check(reviewReferenceSchema, value)) throw new Error("Review reference is invalid");
      return { type: value.type };
    },
    identity: (_reference: ReviewReference) => "workspace",
  }],
  commands: [{ id: "review.open", execute: () => ({ createdWorkView: reviewReference }) }],
  staticFiles: { "/review.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  routes: [{
    async handle(request, url) {
      let match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/refresh$/);
      if (match) return request.method === "POST" ? await refreshedResponse(decodeURIComponent(match[1]!)) : textResponse("Method not allowed", 405);
      match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/comments$/);
      if (match) return request.method === "POST" ? await createComment(decodeURIComponent(match[1]!), request) : textResponse("Method not allowed", 405);
      match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/comments\/([^/]+)\/delete$/);
      if (!match) return undefined;
      if (request.method !== "POST") return textResponse("Method not allowed", 405);
      const workspaceId = decodeURIComponent(match[1]!);
      const { snapshot } = await current(workspaceId);
      deleteReviewComments(workspaceId, [decodeURIComponent(match[2]!)]);
      return turboStreamResponse(await bodyStream(workspaceId, snapshot, listReviewComments(workspaceId)));
    },
  }],
  initialize(context) {
    context.events.on("workspace_agent_turn_finished", async ({ workspaceId }) => {
      const { snapshot, comments } = await refresh(workspaceId);
      context.broadcastWorkspace(workspaceId, await bodyStream(workspaceId, snapshot, comments));
    });
    context.events.on("workspace_agent_prompt_preparing", (event) => {
      const section = promptSection(reviewCommentsForPrompt(event.workspaceId, event.reviewCommentIds));
      if (section) event.sections.push(section);
    });
    context.events.on("workspace_agent_prompt_submitted", async ({ workspaceId, reviewCommentIds }) => {
      deleteReviewComments(workspaceId, reviewCommentIds);
      const { snapshot, comments } = await current(workspaceId);
      context.broadcastWorkspace(workspaceId, await bodyStream(workspaceId, snapshot, comments));
    });
    context.onWorkspaceRemoved((workspaceId) => {
      snapshots.delete(workspaceId);
      deleteReviewState(workspaceId);
    });
  },
  async attachToWorkspace({ workspaceId }) {
    const { snapshot, comments } = await current(workspaceId);
    return {
      workViews: [await renderReviewWorkView(workspaceId, snapshot, comments)],
      commands: [{ id: "review.open", label: "Review", scope: "workspace", surfaces: { ui: { placement: "work-launcher", label: "Review" } } }],
    };
  },
};

export { reviewWorkspaceModule as atelierServerModule };
export { collectReviewSnapshot, type ReviewSnapshot } from "./diff.ts";
