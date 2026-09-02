import { atelierCableConnectionHeader } from "@atelier/shared";
import { getWorkspaceInit } from "@atelier/workspace";
import { isGitProjectInit, neverOfferProjectPreparation } from "@atelier/projects";
import { AtelierCoreError } from "@atelier/core";
import { acceptInitialPromptDraft, removeInitialPromptDraft } from "./initial-prompt-draft.ts";
import { turboStream, turboStreamResponse } from "./html.ts";
import { ids, renderAgentPanePromptInput } from "./render.ts";
import { invalidateAgentView, matchRoute, requireAgentConversation, type AgentRouteHandler, type AgentRouteOptions } from "./route-support.ts";

export async function removeInitialPromptAfterAcceptedAction(request: Request, options: AgentRouteOptions, workspaceId: string, conversationId: string): Promise<string> {
  await removeInitialPromptDraft(workspaceId, conversationId);
  const html = turboStream("remove", ids.initialPromptSuggestion({ workspaceId, conversationId }), "");
  await invalidateAgentView(options, workspaceId, conversationId, request.headers.get(atelierCableConnectionHeader) ?? undefined, html);
  return html;
}

export const handleInitialPromptRequest: AgentRouteHandler = async (request, url, options) => {
  let params: string[] | undefined;
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/initial-prompt-draft\/accept$/)) && request.method === "POST") {
    const ctx = { workspaceId: params[0], conversationId: params[1] };
    await requireAgentConversation(ctx.workspaceId, ctx.conversationId);
    const draft = await acceptInitialPromptDraft(ctx.workspaceId, ctx.conversationId);
    const suggestionRemoved = turboStream("remove", ids.initialPromptSuggestion(ctx), "");
    await invalidateAgentView(options, ctx.workspaceId, ctx.conversationId, request.headers.get(atelierCableConnectionHeader) ?? undefined, suggestionRemoved);
    return turboStreamResponse(`${turboStream("replace", ids.input(ctx), renderAgentPanePromptInput(ctx, draft.prompt))}${suggestionRemoved}`);
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/initial-prompt-draft\/(decline|never)$/)) && request.method === "POST") {
    const ctx = { workspaceId: params[0], conversationId: params[1] };
    await requireAgentConversation(ctx.workspaceId, ctx.conversationId);
    if (params[2] === "never") {
      const init = await getWorkspaceInit(ctx.workspaceId);
      if (!isGitProjectInit(init)) throw new AtelierCoreError("invalid_workspace_source", "workspace is not associated with a project");
      await neverOfferProjectPreparation(init.projectId);
    }
    return turboStreamResponse(await removeInitialPromptAfterAcceptedAction(request, options, ctx.workspaceId, ctx.conversationId));
  }
  return undefined;
};
