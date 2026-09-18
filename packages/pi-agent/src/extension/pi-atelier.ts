import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const configSchema = Type.Object({ url: Type.String(), token: Type.String(), turnFinishedCommand: Type.String() });
type AtelierMcpConfig = Static<typeof configSchema>;
type JsonValue = string | number | boolean | null | JsonValue[] | { [name: string]: JsonValue };
type McpArguments = { [name: string]: JsonValue };
type PiContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function toolContent(content: CallToolResult["content"]): PiContent[] {
  return content.map((item) => {
    if (item.type === "text") return { type: "text", text: item.text };
    if (item.type === "image") return { type: "image", data: item.data, mimeType: item.mimeType };
    throw new Error(`Atelier MCP returned unsupported ${item.type} content`);
  });
}

type LoadConfig = () => Promise<AtelierMcpConfig>;

export function createPiAtelierExtension(loadConfig: LoadConfig) {
  return function piAtelierExtension(pi: ExtensionAPI) {
    let connection: { client: Client; instructions?: string; turnFinishedCommand: string } | undefined;

    pi.on("session_start", async () => {
      const config = await loadConfig();
      const nextClient = new Client({ name: "pi-atelier", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
      });
      try {
        await nextClient.connect(transport);
        const existing = new Set(pi.getAllTools().map((tool) => tool.name));
        let cursor: string | undefined;
        do {
          const listed = await nextClient.listTools(cursor ? { cursor } : undefined);
          for (const tool of listed.tools) {
            if (existing.has(tool.name)) throw new Error(`Atelier MCP tool collides with an existing Pi tool: ${tool.name}`);
            existing.add(tool.name);
            pi.registerTool({
              name: tool.name,
              label: tool.title ?? tool.name,
              description: tool.description ?? tool.title ?? tool.name,
              parameters: Type.Unsafe<McpArguments>(tool.inputSchema),
              async execute(_toolCallId, params, signal, onUpdate) {
                const active = connection;
                if (!active) throw new Error("Atelier MCP session is not connected");
                const result = await active.client.callTool({ name: tool.name, arguments: params }, undefined, {
                  signal,
                  timeout: 3_600_000,
                  onprogress(update) {
                    const text = update.message ?? `Progress: ${update.progress}`;
                    onUpdate?.({ content: [{ type: "text", text }], details: {} });
                  },
                });
                const parsed = CallToolResultSchema.parse(result);
                const content = toolContent(parsed.content);
                if (parsed.isError) throw new Error(content.filter((item) => item.type === "text").map((item) => item.text).join("\n") || `Atelier MCP tool failed: ${tool.name}`);
                return { content, details: {} };
              },
            });
          }
          cursor = listed.nextCursor;
        } while (cursor);
        connection = { client: nextClient, instructions: nextClient.getInstructions(), turnFinishedCommand: config.turnFinishedCommand };
      } catch (error) {
        await nextClient.close();
        throw error;
      }
    });

    pi.on("before_agent_start", async (event) => connection?.instructions ? { systemPrompt: `${event.systemPrompt}\n\n${connection.instructions}` } : undefined);
    pi.on("agent_end", async () => {
      if (!connection) throw new Error("Atelier MCP session is not connected");
      const result = await pi.exec("sh", [connection.turnFinishedCommand]);
      if (result.code !== 0) throw new Error(result.stderr);
    });
    pi.on("session_shutdown", async () => {
      const active = connection;
      connection = undefined;
      await active?.client.close();
    });
  };
}

export default createPiAtelierExtension(async () => Value.Parse(configSchema, JSON.parse(await readFile(new URL("./config.json", import.meta.url), "utf8"))));
