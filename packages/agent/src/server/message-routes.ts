import { readJsonObject, requestAcceptsJson } from "@atelier/core";
import { agentAttachmentDraftId, deliverAttachmentDraft, removeStagedAttachments } from "./attachment-drafts.ts";
import { maybeNameAgentFromPrompt, renameAgentFromContext, setAgentSessionTitle } from "./agent-title-suggestion.ts";
import { turboStreamResponse } from "./html.ts";
import { removeInitialPromptDraft } from "./initial-prompt-draft.ts";
import { expandPromptTemplate, parseAgentSessionNameCommand, parseCompactCommand } from "./prompt-templates.ts";
import { matchRoute, requireAgentConversation, resolveAgentRuntime, type AgentRouteHandler, type AgentRouteOptions } from "./route-support.ts";

export const handleMessageRequest: AgentRouteHandler = async (request, url, options) => {
  const params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/messages$/);
  if (!params || request.method !== "POST") return undefined;
  return await submitMessage(params[0], params[1], request, options);
};

async function submitMessage(workspaceId: string, conversationId: string, request: Request, options: AgentRouteOptions): Promise<Response> {
  const agent = await requireAgentConversation(workspaceId, conversationId);
  const json = requestAcceptsJson(request) ? await readJsonObject(request) : undefined;
  const form = json ? undefined : await request.formData();
  const text = String(json?.text ?? form?.get("text") ?? "");
  if (text.trim() === "/new") {
    const runtime = await resolveAgentRuntime(agent, options);
    await runtime.newSession();
    await removeInitialPromptDraft(workspaceId, conversationId);
    return json ? Response.json({ agent: { conversationId, state: "idle" } }) : turboStreamResponse("");
  }
  if (text.trim() === "/park") {
    await removeInitialPromptDraft(workspaceId, conversationId);
    return new Response(null, { status: 307, headers: { Location: `/workspaces/${encodeURIComponent(workspaceId)}/park` } });
  }
  const compactCommand = parseCompactCommand(text);
  if (compactCommand) {
    const runtime = await resolveAgentRuntime(agent, options);
    await options.events?.emit("workspace_user_activity", { workspaceId });
    await runtime.compact(compactCommand.customInstructions);
    await removeInitialPromptDraft(workspaceId, conversationId);
    return json ? Response.json({ agent: { conversationId, state: "idle", compacted: true } }) : turboStreamResponse("");
  }
  const nameCommand = parseAgentSessionNameCommand(text);
  if (nameCommand) {
    if (nameCommand.title) {
      await setAgentSessionTitle(agent, nameCommand.title, { events: options.events });
    } else {
      const runtime = await resolveAgentRuntime(agent, options);
      renameAgentFromContext(agent, runtime.userMessages(), { events: options.events, agentModel: runtime.currentModel() });
    }
    await removeInitialPromptDraft(workspaceId, conversationId);
    return json ? Response.json({ agent: { conversationId, state: "idle" } }) : turboStreamResponse("");
  }

  const attachmentDraft = agentAttachmentDraftId(workspaceId, conversationId);
  if (form && String(form.get("attachmentDraft") ?? "") !== attachmentDraft) return turboStreamResponse("", { status: 422 });
  const attachmentIds = form?.getAll("attachment").map(String) ?? [];
  const { images, attachmentNotes } = attachmentIds.length > 0
    ? await deliverAttachmentDraft(workspaceId, attachmentDraft, attachmentIds)
    : { images: [], attachmentNotes: [] };
  const reviewCommentIds = (form?.getAll("reviewComment").map(String) ?? []).filter((id) => /^[a-f0-9-]{36}$/.test(id));
  const sections: string[] = [];
  if (reviewCommentIds.length) await options.events?.emit("workspace_agent_prompt_preparing", { workspaceId, reviewCommentIds, sections });
  const expandedText = await expandPromptTemplate(workspaceId, [text, ...sections].filter((section) => section.trim()).join("\n\n"));
  const trimmed = expandedText.trim();
  if (!trimmed && images.length === 0 && attachmentNotes.length === 0) {
    const message = "A prompt or completed attachment is required";
    return json ? Response.json({ error: { code: "invalid_arguments", message } }, { status: 422 }) : turboStreamResponse("", { status: 422 });
  }
  const runtime = await resolveAgentRuntime(agent, options);
  const namingContext = trimmed ? { messages: [...runtime.userMessages(), trimmed], agentModel: runtime.currentModel() } : undefined;
  await runtime.submit(expandedText, { images, attachmentNotes });
  if (namingContext) {
    await options.events?.emit("workspace_user_activity", { workspaceId });
    (options.suggestTitleFromPrompt ?? maybeNameAgentFromPrompt)(agent, namingContext.messages, { events: options.events, agentModel: namingContext.agentModel });
  }
  await removeStagedAttachments(attachmentDraft, attachmentIds);
  if (reviewCommentIds.length) await options.events?.emit("workspace_agent_prompt_submitted", { workspaceId, reviewCommentIds });
  await removeInitialPromptDraft(workspaceId, conversationId);
  const acceptedHeaders = { "x-atelier-attachment-draft-consumed": "true" };
  return json
    ? Response.json({ agent: { conversationId, state: "running" } }, { status: 202, headers: acceptedHeaders })
    : turboStreamResponse("", { headers: acceptedHeaders });
}
