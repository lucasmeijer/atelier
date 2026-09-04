import { listFileCompletions, renderFileCompletionMenu } from "./file-completions.ts";
import { expandPromptTemplate } from "./prompt-templates.ts";
import { matchRoute, requireAgentConversation, type AgentRouteHandler } from "./route-support.ts";

export const handleCompletionRequest: AgentRouteHandler = async (request, url) => {
  let params: string[] | undefined;
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/completions$/)) && request.method === "GET") {
    await requireAgentConversation(params[0], params[1]);
    const query = url.searchParams.get("q") ?? "";
    const mode = url.searchParams.get("mode") === "fuzzy" ? "fuzzy" : "direct";
    return new Response(renderFileCompletionMenu(await listFileCompletions(params[0], query, mode)), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if ((params = matchRoute(url, /^\/workspaces\/([^/]+)\/agents\/([^/]+)\/completions\/prompt-template-expand$/)) && request.method === "POST") {
    await requireAgentConversation(params[0], params[1]);
    const form = await request.formData();
    const expanded = await expandPromptTemplate(params[0], String(form.get("text") ?? ""));
    return new Response(expanded, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return undefined;
};
