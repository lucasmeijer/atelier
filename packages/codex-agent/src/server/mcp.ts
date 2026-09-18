import { shellQuote } from "@atelier/core";
import { execWorkspaceShell } from "@atelier/workspace";

export async function prepareCodexMcp(workspaceId: string, sessionId: string, mcp: { url: string; token: string }): Promise<Record<string, string>> {
  const codexHome = `/home/atelier/.local/share/atelier-agents/${sessionId}/codex`;
  const result = await execWorkspaceShell(workspaceId, `umask 077; mkdir -p ${shellQuote(codexHome)} && ln -s /home/atelier/.codex/auth.json ${shellQuote(codexHome + "/auth.json")} && cat > ${shellQuote(codexHome + "/config.toml")}`, {
    stdin: `[mcp_servers.atelier]\nurl = ${JSON.stringify(mcp.url)}\nrequired = true\ntool_timeout_sec = 3600\n[mcp_servers.atelier.http_headers]\nAuthorization = ${JSON.stringify("Bearer " + mcp.token)}\n`,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Command failed (exit ${result.exitCode})`);
  return { CODEX_HOME: codexHome };
}
