import { fileURLToPath } from "node:url";
import type { CliAgentSession } from "@atelier/cli-agent/server";
import { shellQuote } from "@atelier/core";
import { execWorkspaceShell } from "@atelier/workspace";

function piAtelierDirectory(sessionId: string): string {
  return `/home/atelier/.local/share/atelier-agents/${sessionId}/pi-atelier`;
}

export function piAtelierExtensionPath(sessionId: string): string {
  return `${piAtelierDirectory(sessionId)}/extension.mjs`;
}

let bundledExtension: Promise<string> | undefined;
function buildExtension(): Promise<string> {
  return bundledExtension ??= (async () => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL("../extension/pi-atelier.ts", import.meta.url))],
      target: "node",
      format: "esm",
      minify: true,
      sourcemap: "none",
    });
    if (!result.success) throw new Error(`Could not bundle the pi-atelier extension: ${result.logs.map(String).join("\n")}`);
    return await result.outputs[0]!.text();
  })();
}

/** Install the required Atelier MCP bridge and its session-scoped credential. */
export async function preparePiMcp(workspaceId: string, session: CliAgentSession, mcp: { url: string; token: string }): Promise<Record<string, string>> {
  const directory = piAtelierDirectory(session.id);
  const extension = await buildExtension();
  const config = JSON.stringify({ ...mcp, turnFinishedCommand: session.turnFinishedCommand });
  const result = await execWorkspaceShell(workspaceId, `set -eu
umask 077
mkdir -p ${shellQuote(directory)}
dd bs=1 count=${Buffer.byteLength(extension)} of=${shellQuote(piAtelierExtensionPath(session.id))} status=none
cat > ${shellQuote(`${directory}/config.json`)}`, { stdin: extension + config });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Command failed (exit ${result.exitCode})`);
  return {};
}
