import type { AtelierEventBus } from "@atelier/core";
import { execWorkspaceShell } from "@atelier/workspace";
import { authenticateAgentRequest, createAgentMcpCredentials } from "./mcp-credentials.ts";
import { createAgentMcpServer } from "./mcp-server.ts";
import { createAtelierControlTools } from "./tools.ts";
import { createRegisteredOnboardingTools } from "./onboarding-tools.ts";
import { isProjectOnboardingWorkspace } from "./workspace-capabilities.ts";

const atelierMcpInstructions = `You are working inside an Atelier Docker workspace. Use Atelier tools to present your work and manage only your authorized workspace/project. Your identity is supplied by Atelier; never attempt to impersonate another agent.
Start dev servers in tmux, using any available port except 2999. Prefer hot reload. Use present(kind="browser", url="http://localhost:PORT") for interactive apps; desktop for browser automation; tmux for terminals. Leave the result ready for the user to evaluate.
For static images, videos, SVG or HTML, use Markdown ![](atelier-embed:/absolute/path). Link editable files with [label](atelier://file/absolute/path?line=42). Do not use present for static artifacts.
Read /opt/atelier/docs/atelier.md when asked about Atelier features. Delete a workspace only on explicit user request; force requires explicit approval to discard unsaved work.`;

function agentMcpInstructions(workspaceId: string): string {
  return atelierMcpInstructions + (isProjectOnboardingWorkspace(workspaceId) ? `\nThis is a project-onboarding workspace. Help configure project settings and improve workspace startup time. Investigate/build in workspaces you create, not this recovery workspace. Iterate with create_workspace, bash_in_other_workspace and delete_workspace. Present proposed changes before write_project_settings. Explain why a secret is needed and obtain agreement before request_secret_value. Do not commit or push without explicit user request and confirmation. Finish by saving good project settings.` : "");
}

let credentials: ReturnType<typeof createAgentMcpCredentials> | undefined;
function credentialStore() { return credentials ??= createAgentMcpCredentials(); }
let events: AtelierEventBus | undefined;
const mcp = createAgentMcpServer({
  authenticate: (token) => credentialStore().authenticate(token),
  tools: ({ workspaceId, agentId }) => [...createAtelierControlTools(workspaceId, { events }), ...createRegisteredOnboardingTools(workspaceId, agentId)],
  instructions: ({ workspaceId }) => agentMcpInstructions(workspaceId),
});
export function configureAgentMcp(eventBus: AtelierEventBus): void {
  events = eventBus;
  eventBus.on("workspace_deleting", async ({ workspaceId }) => {
    credentialStore().revokeWorkspace(workspaceId);
    await mcp.revoke({ workspaceId });
  });
}
export function handleAgentMcpRequest(request: Request, workspaceId?: string): Promise<Response> | undefined {
  const path = new URL(request.url).pathname;
  if (path === "/mcp") return mcp.fetch(request, workspaceId);
  if (path === "/agent-turn-finished") return handleTurnFinished(request, workspaceId);
}

export async function revokeAgentMcp(workspaceId: string, agentId: string): Promise<void> {
  credentialStore().revoke({ workspaceId, agentId });
  await mcp.revoke({ workspaceId, agentId });
}

/** Start the workspace relay; the CLI owns writing credentials into its private configuration. */
export async function prepareAgentMcp(workspaceId: string, agentId: string) {
  const result = await execWorkspaceShell(workspaceId, `set -eu
# One loopback HTTP listener per workspace; parent Unix sockets survive host restarts.
(
  flock 9
  if ! curl --noproxy '*' --max-time 2 --silent http://127.0.0.1:2988/health | grep -qx ok; then
    nohup socat TCP4-LISTEN:2988,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/atelier-parent/ingress.sock > /tmp/atelier-mcp.log 2>&1 < /dev/null 9>&- &
  fi
) 9>/tmp/atelier-mcp.lock
for attempt in $(seq 1 50); do
  if curl --noproxy '*' --max-time 2 --silent http://127.0.0.1:2988/health | grep -qx ok; then exit 0; fi
  sleep .1
done
cat /tmp/atelier-mcp.log >&2
exit 1`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not start workspace MCP relay");
  return { url: "http://127.0.0.1:2988/mcp", token: credentialStore().issue({ workspaceId, agentId }) };
}

async function handleTurnFinished(request: Request, workspaceId?: string): Promise<Response> {
  const identity = authenticateAgentRequest(request, credentialStore().authenticate, workspaceId);
  if (identity instanceof Response) return identity;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  await events!.emit("workspace_agent_turn_finished", { workspaceId: identity.workspaceId, conversationId: identity.agentId });
  return new Response(null, { status: 204 });
}
