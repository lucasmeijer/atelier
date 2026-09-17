import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentMcpIdentity } from "./mcp-credentials.ts";

export interface AgentMcpServerOptions {
  authenticate(token: string): AgentMcpIdentity | undefined;
  tools(identity: AgentMcpIdentity): ToolDefinition<any, any>[];
  instructions(identity: AgentMcpIdentity): string;
}

/** Authentication is checked on every HTTP request, independently of MCP session identity. */
export function createAgentMcpServer(options: AgentMcpServerOptions) {
  const sessions = new Map<string, { identity: AgentMcpIdentity; transport: WebStandardStreamableHTTPServerTransport; server: Server }>();
  return {
    async fetch(request: Request, workspaceId?: string): Promise<Response> {
      // Only launched CLI clients use this endpoint. No browser origins or cookie authentication.
      if (request.headers.has("origin")) return new Response("Browser origins are not allowed", { status: 403 });
      const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
      const identity = token ? options.authenticate(token) : undefined;
      if (!identity || (workspaceId !== undefined && workspaceId !== identity.workspaceId)) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="atelier-mcp"', "Cache-Control": "no-store" } });
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session || (session.identity.workspaceId !== identity.workspaceId || session.identity.agentId !== identity.agentId)) return new Response("Unknown MCP session", { status: 404 });
        return session.transport.handleRequest(request);
      }
      if (request.method !== "POST") return new Response("MCP initialization required", { status: 400 });
      // Tool visibility is fixed for the workspace lifetime; build definitions once per session.
      const tools = new Map(options.tools(identity).map((tool) => [tool.name, tool]));
      const server = new Server({ name: "atelier", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: options.instructions(identity) });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, { identity, server, transport }); },
        onsessionclosed: (id) => { sessions.delete(id); },
      });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools.values()].map((tool) => ({ name: tool.name, title: tool.label, description: tool.description, inputSchema: tool.parameters })) }));
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const tool = tools.get(request.params.name);
        if (!tool) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
        const args = request.params.arguments ?? {};
        if (!Value.Check(tool.parameters, args)) throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments");
        try {
          let progress = 0;
          let updates = Promise.resolve();
          const progressToken = request.params._meta?.progressToken;
          const result = await tool.execute(String(extra.requestId), args, extra.signal, progressToken === undefined ? undefined : (update) => {
            const message = update.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
            const current = ++progress;
            updates = updates.then(() => extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: current, message } }));
          }, undefined!);
          await updates;
          return { content: result.content };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
        }
      });
      await server.connect(transport);
      const response = await transport.handleRequest(request);
      if (!transport.sessionId) await server.close();
      return response;
    },
    async revoke(identity: { workspaceId: string; agentId?: string }): Promise<void> {
      for (const [id, session] of sessions) {
        if (session.identity.workspaceId === identity.workspaceId && (!identity.agentId || session.identity.agentId === identity.agentId)) {
          sessions.delete(id);
          await session.server.close();
        }
      }
    },
  };
}
