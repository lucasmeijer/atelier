import { dirname } from "node:path";
import type { CliAgentSession } from "@atelier/cli-agent/server";
import { shellQuote } from "@atelier/core";
import { execWorkspaceShell } from "@atelier/workspace";

/** Session-private MCP configuration; the bearer token never reaches a command line. */
export function claudeMcpConfigPath(sessionId: string): string {
  return `/home/atelier/.local/share/atelier-agents/${sessionId}/claude-mcp.json`;
}

export async function prepareClaudeMcp(workspaceId: string, session: CliAgentSession, mcp: { url: string; token: string }): Promise<Record<string, string>> {
  const path = claudeMcpConfigPath(session.id);
  const config = { mcpServers: { atelier: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } };
  const result = await execWorkspaceShell(workspaceId, `umask 077; mkdir -p ${shellQuote(dirname(path))} && cat > ${shellQuote(path)}`, { stdin: JSON.stringify(config) });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Command failed (exit ${result.exitCode})`);
  return {};
}
