import {
  findStagedAttachment,
  removeAttachmentDraft,
  removeStagedAttachment,
  stageAttachment,
  validDraftId,
} from "./attachment-drafts.ts";
import { domId, turboStream, turboStreamResponse } from "@atelier/shared";
import { renderAttachmentChip } from "./render-attachments.ts";
function matchRoute(url: URL, expression: RegExp): string[] | undefined {
  return url.pathname.match(expression)?.slice(1).map(decodeURIComponent);
}

export const handleAttachmentRequest = async (request: Request, url: URL): Promise<Response | undefined> => {
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
  return turboStreamResponse(turboStream("append", rowId || domId("agent_draft_attach", draftId), chip));
}

async function deleteAttachment(draftId: string, attachmentId: string): Promise<Response> {
  if (!await findStagedAttachment(draftId, attachmentId)) return turboStreamResponse("", { status: 404 });
  await removeStagedAttachment(draftId, attachmentId);
  return turboStreamResponse(turboStream("remove", domId("agent_draft_chip", draftId, attachmentId)));
}
