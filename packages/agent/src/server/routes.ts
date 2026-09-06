import { handleAttachmentRequest } from "./attachment-routes.ts";
import { handleCompletionRequest } from "./completion-routes.ts";
import { handleConfigurationRequest } from "./configuration-routes.ts";
import { handleMessageRequest } from "./message-routes.ts";
import type { AgentRouteHandler, AgentRouteOptions } from "./route-support.ts";
import { handleSessionRequest } from "./session-routes.ts";

const agentRouteHandlers: readonly AgentRouteHandler[] = [
  handleAttachmentRequest,
  handleCompletionRequest,
  handleMessageRequest,
  handleSessionRequest,
  handleConfigurationRequest,
];

export async function handleAgentRequest(request: Request, url: URL, options: AgentRouteOptions = {}): Promise<Response | undefined> {
  for (const handle of agentRouteHandlers) {
    const response = await handle(request, url, options);
    if (response) return response;
  }
  return undefined;
}
