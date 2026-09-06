import { requestAcceptsJson } from "@atelier/core";
import { ids } from "./render-context.ts";
import { turboStream, turboStreamResponse } from "./html.ts";
import { resolveAgentRuntime, invalidateAgentView, matchRoute, requireAgentConversation, requireAgentRuntime, type AgentRouteHandler } from "./route-support.ts";
import { sessionImageEndpoint } from "./session-images.ts";
import { handleAgentTreeRequest } from "./session-tree.ts";

export const handleSessionRequest: AgentRouteHandler = async (request, url, options) => {
  let params: string[] | undefined;
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/reveal\/([^/]+)$/)) && request.method === "GET") {
    const [workspaceId, conversationId, target] = params;
    const runtime = await requireAgentRuntime(workspaceId, conversationId, options);
    const state = await runtime.paneState(target);
    return turboStreamResponse(turboStream("update", ids.transcript({ workspaceId, conversationId }), state.transcriptHtml));
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/transcript-items\/([^/]+)$/)) && request.method === "GET") {
    const runtime = await resolveAgentRuntime(await requireAgentConversation(params[0], params[1], options.events), options);
    const count = Math.max(100, Math.min(100_000, Number(url.searchParams.get("count") ?? 100) || 100));
    const html = await runtime.detailHtml(params[2], count);
    return new Response(html || "not found", { status: html ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/session-images\/([^/]+)\/(\d+)$/)) && request.method === "GET") {
    const agent = await requireAgentConversation(params[0], params[1], options.events);
    return await sessionImageEndpoint(agent.path, params[2], Number(params[3]));
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/tree(\/summary|\/label|)$/))) {
    const [workspaceId, conversationId, suffix] = params;
    const response = await handleAgentTreeRequest(request, url, suffix, async () => await requireAgentRuntime(workspaceId, conversationId, options));
    if (response && request.method === "POST") await invalidateAgentView(options, workspaceId, conversationId);
    return response;
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/abort$/)) && request.method === "POST") {
    const runtime = await requireAgentRuntime(params[0], params[1], options);
    await runtime.abort();
    await invalidateAgentView(options, params[0], params[1]);
    return requestAcceptsJson(request) ? Response.json({ agent: { conversationId: params[1], state: "idle", aborted: true } }) : turboStreamResponse("");
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/rewind$/)) && request.method === "POST") {
    const form = await request.formData();
    const entry = String(form.get("entry") ?? "");
    const mode = String(form.get("rewindMode") ?? "discard") === "summary" ? "summary" : "discard";
    const customInstructions = mode === "summary" ? String(form.get("customInstructions") ?? "") : undefined;
    const runtime = await requireAgentRuntime(params[0], params[1], options);
    if (entry) {
      await runtime.rewind(entry, mode, customInstructions);
      await invalidateAgentView(options, params[0], params[1]);
    }
    return turboStreamResponse("");
  }
  return undefined;
};
