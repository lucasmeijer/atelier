import type { JsonValue } from "@atelier/core";
import { turboStream, turboStreamResponse, type WorkspaceModule } from "@atelier/shared";
import { workspaceWorkHostPath } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { reviewCommentsPrompt, type ReviewSide } from "../model.ts";
import { collectReviewFile, collectReviewIndex, collectReviewStats, reviewSnippet, type ReviewIndex } from "./diff.ts";
import { renderReviewBody, renderReviewFileDetails, renderReviewStatsFrame, reviewBodyId, reviewFileFrameId, reviewReference, reviewWorkViewPresentation } from "./render.ts";
import { addReviewComment, deleteReviewComments, deleteReviewState, listReviewComments, reconcileReviewComments, remapReviewFileComments, reviewCommentsForPrompt, updateReviewComment, type ReviewComment } from "./state.ts";

const reviewReferenceSchema = Type.Object({ type: Type.Literal("review") });
type ReviewReference = Static<typeof reviewReferenceSchema>;
const indexes = new Map<string, ReviewIndex>();

function textResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function refresh(workspaceId: string): Promise<{ index: ReviewIndex; comments: ReviewComment[] }> {
  const index = await collectReviewIndex(workspaceWorkHostPath(workspaceId));
  indexes.set(workspaceId, index);
  return { index, comments: reconcileReviewComments(workspaceId, index) };
}

async function current(workspaceId: string): Promise<{ index: ReviewIndex; comments: ReviewComment[] }> {
  const index = indexes.get(workspaceId);
  return index ? { index, comments: listReviewComments(workspaceId) } : await refresh(workspaceId);
}

function bodyStream(workspaceId: string, index: ReviewIndex, comments: ReviewComment[]): string {
  return turboStream("replace", reviewBodyId(workspaceId), renderReviewBody(workspaceId, index, comments));
}

async function refreshedResponse(workspaceId: string): Promise<Response> {
  const { index, comments } = await refresh(workspaceId);
  return turboStreamResponse(bodyStream(workspaceId, index, comments));
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
  const file = await collectReviewFile(workspaceWorkHostPath(workspaceId), path);
  if (!file || file.kind !== "text") return textResponse("Review file is no longer available", 409);
  const snippet = reviewSnippet(file, side, startLine, endLine);
  if (!snippet && startLine !== 1) return textResponse("Review line is no longer available", 409);
  addReviewComment(workspaceId, { path, side, startLine, endLine, body, snippet });
  const { index } = await refresh(workspaceId);
  return turboStreamResponse(bodyStream(workspaceId, index, listReviewComments(workspaceId)));
}

async function updateComment(workspaceId: string, id: string, request: Request): Promise<Response> {
  const body = String((await request.formData()).get("body") ?? "").trim();
  if (!body || body.length > 20_000) return textResponse("Invalid review comment", 422);
  const { index } = await current(workspaceId);
  if (!updateReviewComment(workspaceId, id, body)) return textResponse("Review comment not found", 404);
  return turboStreamResponse(bodyStream(workspaceId, index, listReviewComments(workspaceId)));
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
    async render({ workspaceId }) {
      const { index, comments } = await current(workspaceId);
      return renderReviewBody(workspaceId, index, comments);
    },
  }],
  commands: [{ id: "review.open", execute: () => ({ createdWorkView: reviewReference }) }],
  staticFiles: { "/review.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  routes: [{
    async handle(request, url) {
      let match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/refresh$/);
      if (match) return request.method === "POST" ? await refreshedResponse(decodeURIComponent(match[1]!)) : textResponse("Method not allowed", 405);
      match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/stats$/);
      if (match) {
        if (request.method !== "GET") return textResponse("Method not allowed", 405);
        const workspaceId = decodeURIComponent(match[1]!);
        const { index } = await current(workspaceId);
        const stats = await collectReviewStats(workspaceWorkHostPath(workspaceId), index);
        return htmlResponse(renderReviewStatsFrame(workspaceId, stats));
      }
      match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/files\/([^/]+)$/);
      if (match) {
        if (request.method !== "GET") return textResponse("Method not allowed", 405);
        const workspaceId = decodeURIComponent(match[1]!);
        const path = decodeURIComponent(match[2]!);
        const file = await collectReviewFile(workspaceWorkHostPath(workspaceId), path);
        if (!file) return htmlResponse(`<turbo-frame id="${reviewFileFrameId(workspaceId, path)}"><div class="review-file-unavailable" role="note">This change is no longer available. Refresh Review to update the file list.</div></turbo-frame>`);
        const comments = remapReviewFileComments(workspaceId, file);
        return htmlResponse(await renderReviewFileDetails(workspaceId, file, comments));
      }
      match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/comments$/);
      if (match) return request.method === "POST" ? await createComment(decodeURIComponent(match[1]!), request) : textResponse("Method not allowed", 405);
      match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/comments\/delete$/);
      if (match) {
        if (request.method !== "POST") return textResponse("Method not allowed", 405);
        const workspaceId = decodeURIComponent(match[1]!);
        const { index, comments } = await current(workspaceId);
        deleteReviewComments(workspaceId, comments.map((comment) => comment.id));
        return turboStreamResponse(bodyStream(workspaceId, index, []));
      }
      match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/comments\/([^/]+)\/update$/);
      if (match) return request.method === "POST" ? await updateComment(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), request) : textResponse("Method not allowed", 405);
      match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/comments\/([^/]+)\/delete$/);
      if (!match) return undefined;
      if (request.method !== "POST") return textResponse("Method not allowed", 405);
      const workspaceId = decodeURIComponent(match[1]!);
      const { index } = await current(workspaceId);
      deleteReviewComments(workspaceId, [decodeURIComponent(match[2]!)]);
      return turboStreamResponse(bodyStream(workspaceId, index, listReviewComments(workspaceId)));
    },
  }],
  initialize(context) {
    context.events.on("workspace_agent_turn_finished", async ({ workspaceId }) => {
      const { index, comments } = await refresh(workspaceId);
      context.broadcastWorkspace(workspaceId, bodyStream(workspaceId, index, comments));
    });
    context.events.on("workspace_agent_prompt_preparing", (event) => {
      const section = reviewCommentsPrompt(reviewCommentsForPrompt(event.workspaceId, event.reviewCommentIds));
      if (section) event.sections.push(section);
    });
    context.events.on("workspace_agent_prompt_submitted", async ({ workspaceId, reviewCommentIds }) => {
      deleteReviewComments(workspaceId, reviewCommentIds);
      const { index, comments } = await current(workspaceId);
      context.broadcastWorkspace(workspaceId, bodyStream(workspaceId, index, comments));
    });
    context.onWorkspaceRemoved((workspaceId) => {
      indexes.delete(workspaceId);
      deleteReviewState(workspaceId);
    });
  },
  attachToWorkspace() {
    return {
      workViews: [reviewWorkViewPresentation],
      commands: [{ id: "review.open", label: "Review", scope: "workspace", surfaces: { ui: { placement: "work-launcher", label: "Review" } } }],
    };
  },
};

export { reviewWorkspaceModule as atelierServerModule };
