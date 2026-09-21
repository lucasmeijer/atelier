import { renderReviewFileContent } from "./render.ts";
import type { JsonValue } from "@atelier/core";
import { Icons } from "@atelier/design-system/icons";
import { turboStreamResponse, type WorkspaceModule } from "@atelier/shared";
import { workspaceWorkHostPath } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { isReviewDiffHighlighting, isReviewDiffOverflow, reviewCommentsPrompt, type ReviewSide } from "../model.ts";
import { clearDeletionReview, deletionReviewCommitResponse, deletionReviewFileResponse, reviewDeletionReview } from "./deletion.ts";
import { collectReviewFile, collectReviewIndex, collectReviewStats, reviewSnippet, type ReviewIndex } from "./diff.ts";
import { renderReviewBody, renderReviewFileDetails, renderReviewMoreFiles, renderReviewTitle, reviewFileFrameId, reviewFilePageSize, reviewReference, reviewWorkViewPresentation } from "./render.ts";
import {
  isReviewDiffLayout,
  isReviewViewport,
  readReviewSettings,
  updateReviewSettings,
} from "./settings.ts";
import { addReviewComment, deleteReviewComments, deleteReviewState, listReviewComments, reconcileReviewComments, remapReviewFileComments, reviewCommentsForPrompt, updateReviewComment, type ReviewComment } from "./state.ts";

const reviewReferenceSchema = Type.Object({ type: Type.Literal("review") });
type ReviewReference = Static<typeof reviewReferenceSchema>;
const indexes = new Map<string, ReviewIndex>();
const reviewTitles = new Map<string, string>();

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

async function refreshStats(workspaceId: string, index: ReviewIndex) {
  const files = await collectReviewStats(workspaceWorkHostPath(workspaceId), index);
  const title = index.phase === "ready" ? renderReviewTitle(files) : reviewWorkViewPresentation.label;
  reviewTitles.set(workspaceId, title);
  return { files, title };
}

async function refreshedResponse(workspaceId: string): Promise<Response> {
  await refresh(workspaceId);
  return turboStreamResponse("");
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
  return turboStreamResponse("");
}

async function updateComment(workspaceId: string, id: string, request: Request): Promise<Response> {
  const body = String((await request.formData()).get("body") ?? "").trim();
  if (!body || body.length > 20_000) return textResponse("Invalid review comment", 422);
  const comment = listReviewComments(workspaceId).find((candidate) => candidate.id === id);
  if (!comment) return textResponse("Review comment not found", 404);
  const file = await collectReviewFile(workspaceWorkHostPath(workspaceId), comment.path);
  if (!file || file.kind !== "text") return textResponse("Review file is no longer available", 409);
  updateReviewComment(workspaceId, id, body);
  return turboStreamResponse("");
}

export const reviewWorkspaceModule: WorkspaceModule = {
  id: "review",
  liveSurfaces: [{ name: "review-file", async load({ workspaceId, key }) {
    const file = await collectReviewFile(workspaceWorkHostPath(workspaceId), key);
    return [{ target: reviewFileFrameId(workspaceId, key), html: file
      ? await renderReviewFileContent(workspaceId, file, remapReviewFileComments(workspaceId, file))
      : '<p role="note">This change is no longer available.</p>' }];
  } }],
  deletionReview: reviewDeletionReview,
  workViews: [{
    type: "review",
    parseReference(value: JsonValue) {
      if (!Value.Check(reviewReferenceSchema, value)) throw new Error("Review reference is invalid");
      return { type: value.type };
    },
    identity: (_reference: ReviewReference) => "workspace",
    async render({ workspaceId }) {
      const { index, comments } = await current(workspaceId);
      const { files } = await refreshStats(workspaceId, index);
      return renderReviewBody(workspaceId, index, comments, await readReviewSettings(), files);
    },
  }],
  commands: [{ id: "review.open", execute: () => ({ createdWorkView: reviewReference }) }],
  staticFiles: { "/review.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  routes: [{
    async handle(request, url) {
      if (url.pathname.startsWith("/review/settings/")) {
        if (request.method !== "POST") return textResponse("Method not allowed", 405);
        const form = await request.formData();
        if (url.pathname === "/review/settings/diff-layout") {
          const viewport = url.searchParams.get("viewport") ?? "";
          const value = String(form.get("review-diff-layout") ?? "");
          if (!isReviewViewport(viewport) || !isReviewDiffLayout(value)) return textResponse("Invalid review diff layout", 422);
          await updateReviewSettings({ [viewport]: value });
        } else if (url.pathname === "/review/settings/diff-highlighting") {
          const value = String(form.get("review-diff-highlighting") ?? "");
          if (!isReviewDiffHighlighting(value)) return textResponse("Invalid review diff highlighting", 422);
          await updateReviewSettings({ highlighting: value });
        } else if (url.pathname === "/review/settings/diff-overflow") {
          const value = String(form.get("review-diff-overflow") ?? "");
          if (!isReviewDiffOverflow(value)) return textResponse("Invalid review diff overflow", 422);
          await updateReviewSettings({ overflow: value });
        } else {
          return textResponse("Not found", 404);
        }
        return turboStreamResponse("");
      }
      let match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/deletion\/file$/);
      if (match) return request.method === "GET" ? await deletionReviewFileResponse(decodeURIComponent(match[1]!), url) : textResponse("Method not allowed", 405);
      match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/deletion\/commit$/);
      if (match) return request.method === "GET" ? await deletionReviewCommitResponse(decodeURIComponent(match[1]!), url) : textResponse("Method not allowed", 405);
      match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/refresh$/);
      if (match) return request.method === "POST" ? await refreshedResponse(decodeURIComponent(match[1]!)) : textResponse("Method not allowed", 405);
      match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/more-files$/);
      if (match) {
        if (request.method !== "GET") return textResponse("Method not allowed", 405);
        const workspaceId = decodeURIComponent(match[1]!);
        const offset = Number(url.searchParams.get("offset"));
        if (!Number.isSafeInteger(offset) || offset < reviewFilePageSize || offset % reviewFilePageSize !== 0) return textResponse("Invalid review file offset", 422);
        const { index, comments } = await current(workspaceId);
        const { files } = await refreshStats(workspaceId, index);
        return htmlResponse(renderReviewMoreFiles(workspaceId, index, comments, offset, files));
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
        const { comments } = await current(workspaceId);
        deleteReviewComments(workspaceId, comments.map((comment) => comment.id));
        return turboStreamResponse("");
      }
      match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/comments\/([^/]+)\/update$/);
      if (match) return request.method === "POST" ? await updateComment(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), request) : textResponse("Method not allowed", 405);
      match = url.pathname.match(/^\/workspaces\/([^/]+)\/review\/comments\/([^/]+)\/delete$/);
      if (!match) return undefined;
      if (request.method !== "POST") return textResponse("Method not allowed", 405);
      const workspaceId = decodeURIComponent(match[1]!);
      const id = decodeURIComponent(match[2]!);
      const comment = listReviewComments(workspaceId).find((candidate) => candidate.id === id);
      if (!comment) return textResponse("Review comment not found", 404);
      deleteReviewComments(workspaceId, [id]);
      return turboStreamResponse("");
    },
  }],
  initialize(context) {
    context.events.on("workspace_agent_turn_finished", async ({ workspaceId }) => {
      await refresh(workspaceId);
      context.invalidateWorkspace(workspaceId);
    });
    context.events.on("workspace_agent_prompt_preparing", (event) => {
      const section = reviewCommentsPrompt(reviewCommentsForPrompt(event.workspaceId, event.reviewCommentIds));
      if (section) event.sections.push(section);
    });
    context.events.on("workspace_agent_prompt_submitted", ({ workspaceId, reviewCommentIds }) => {
      deleteReviewComments(workspaceId, reviewCommentIds);
      context.invalidateWorkspace(workspaceId);
    });
    context.onWorkspaceRemoved((workspaceId) => {
      indexes.delete(workspaceId);
      reviewTitles.delete(workspaceId);
      deleteReviewState(workspaceId);
      clearDeletionReview(workspaceId);
    });
  },
  attachToWorkspace({ workspaceId }) {
    const workView = { ...reviewWorkViewPresentation, label: reviewTitles.get(workspaceId) ?? reviewWorkViewPresentation.label };
    return {
      workViews: [workView],
      commands: [{ id: "review.open", label: "Review", description: "Show Review. New workspaces include it by default; use this command to reopen it after closing.", scope: "workspace", surfaces: { ui: { placement: "work-launcher", iconHtml: Icons.Review, label: "Review" } } }],
    };
  },
};

export { reviewWorkspaceModule as atelierServerModule };
