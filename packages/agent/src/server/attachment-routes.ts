import {
  findStagedAttachment,
  removeAttachmentDraft,
  removeStagedAttachment,
  stageAttachment,
  validDraftId,
} from "./attachment-drafts.ts";
import { turboStream, turboStreamResponse } from "./html.ts";
import { ids, renderAttachmentChip } from "./render.ts";
import { matchRoute, type AgentRouteHandler } from "./route-support.ts";

export const handleAttachmentRequest: AgentRouteHandler = async (request, url) => {
  let params: string[] | undefined;
  if ((params = matchRoute(url, /^\/agent-attachment-drafts\/([^/]+)\/attachments$/)) && request.method === "POST") {
    return await uploadAttachment(params[0], request, url.searchParams.get("row") ?? undefined);
  }
  if ((params = matchRoute(url, /^\/agent-attachment-drafts\/([^/]+)\/attachments\/([^/]+)\/delete$/)) && request.method === "POST") {
    return await deleteAttachment(params[0], params[1]);
  }
  if ((params = matchRoute(url, /^\/agent-attachment-drafts\/([^/]+)\/discard$/)) && request.method === "POST") {
    if (!validDraftId(params[0])) return new Response("invalid attachment draft", { status: 400 });
    await removeAttachmentDraft(params[0]);
    return new Response(null, { status: 204 });
  }
  return undefined;
};

async function uploadAttachment(draftId: string, request: Request, rowId?: string): Promise<Response> {
  if (!validDraftId(draftId)) return turboStreamResponse("", { status: 400 });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return turboStreamResponse("", { status: 400 });
  const staged = await stageAttachment(draftId, file);
  const chip = renderAttachmentChip(staged, draftId);
  return turboStreamResponse(turboStream("append", rowId || ids.draftAttachRow(draftId), chip));
}

async function deleteAttachment(draftId: string, attachmentId: string): Promise<Response> {
  if (!await findStagedAttachment(draftId, attachmentId)) return turboStreamResponse("", { status: 404 });
  await removeStagedAttachment(draftId, attachmentId);
  return turboStreamResponse(turboStream("remove", ids.draftChip(draftId, attachmentId)));
}
