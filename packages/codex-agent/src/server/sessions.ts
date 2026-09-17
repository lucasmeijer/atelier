import { prepareAgentMcp, revokeAgentMcp } from "@atelier/agent/server";
import { AtelierCoreError, createKeyedOperationQueue, shellQuote } from "@atelier/core";
import { createPiModelRuntime, installSubscriptionCli } from "@atelier/llm/server";
import { buildObservableSessionCommand } from "@atelier/observable-terminal/server";
import { imageMimeByExtension } from "@atelier/prompt/server";
import type { WorkspaceAgentInput } from "@atelier/shared";
import { createWorkspaceMetadataState, execWorkspaceShell, workspaceRoot } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { requireCodexSubscription } from "./auth.ts";
import type { CodexLaunchSettings } from "./model-settings.ts";
import { codexLaunchScript } from "./launch-command.ts";

const inputSchema = Type.Object({ text: Type.String(), images: Type.Array(Type.Object({ mimeType: Type.String(), data: Type.String() })), attachmentNotes: Type.Array(Type.String()) });
const sessionSchema = Type.Object({
  id: Type.String(), title: Type.String(), tmuxSession: Type.String(), input: inputSchema,
  // Older persisted tabs are shell placeholders; never execute their saved prompts.
  kind: Type.Optional(Type.Literal("codex")), error: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(Type.String()),
});
const stateSchema = Type.Object({ sessions: Type.Array(sessionSchema) });
export type CodexSession = Static<typeof sessionSchema>;
let state: ReturnType<typeof createStore> | undefined;
function createStore() { return createWorkspaceMetadataState("codex-agents.json", (value) => Value.Parse(stateSchema, value), () => ({ sessions: [] })); }
function store() { return state ??= createStore(); }
const serialize = createKeyedOperationQueue();

export function listCodexSessions(workspaceId: string): CodexSession[] { return store().read(workspaceId).sessions; }
export function codexSession(workspaceId: string, id: string): CodexSession {
  const session = listCodexSessions(workspaceId).find((session) => session.id === id);
  if (!session) throw new AtelierCoreError("agent_conversation_not_found", `Codex conversation not found: ${id}`);
  return session;
}

async function checkedShell(workspaceId: string, command: string, stdin?: string): Promise<void> {
  const result = await execWorkspaceShell(workspaceId, command, { stdin });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Command failed (exit ${result.exitCode})`);
}

export function createCodexSession(workspaceId: string, input: WorkspaceAgentInput = { text: "", images: [], attachmentNotes: [] }, settings: CodexLaunchSettings = {}): Promise<string> {
  return serialize(workspaceId, async () => {
    await requireCodexSubscription();
    const id = crypto.randomUUID();
    const session: CodexSession = { id, title: input.text.trim().split("\n")[0]?.slice(0, 64) || "Codex", tmuxSession: `codex-${id}`, input, kind: "codex", model: settings.model, thinkingLevel: settings.thinkingLevel };
    // Claim the launch before any side effects. Recovery must never submit its prompt twice.
    store().write(workspaceId, { sessions: [...listCodexSessions(workspaceId), session] });
    try {
      await installSubscriptionCli(workspaceId, await createPiModelRuntime());
      const directory = `${workspaceRoot}/.atelier-attachments/codex-${id}`;
      const imagePaths: string[] = [];
      for (const [index, image] of input.images.entries()) {
        const extension = Object.entries(imageMimeByExtension).find(([, mime]) => mime === image.mimeType)?.[0];
        if (!extension) throw new Error(`Unsupported image type: ${image.mimeType}`);
        const path = `${directory}/${index}.${extension}`;
        await checkedShell(workspaceId, `mkdir -p ${shellQuote(directory)} && base64 -d > ${shellQuote(path)}`, image.data);
        imagePaths.push(path);
      }
      const mcp = await prepareAgentMcp(workspaceId, id);
      const codexHome = `/home/atelier/.local/share/atelier-agents/${id}/codex`;
      await checkedShell(workspaceId, `umask 077; mkdir -p ${shellQuote(codexHome)} && ln -s /home/atelier/.codex/auth.json ${shellQuote(codexHome + "/auth.json")} && cat > ${shellQuote(codexHome + "/config.toml")}`, `[mcp_servers.atelier]\nurl = ${JSON.stringify(mcp.url)}\nrequired = true\ntool_timeout_sec = 3600\n[mcp_servers.atelier.http_headers]\nAuthorization = ${JSON.stringify("Bearer " + mcp.token)}\n`);
      // Keep prompt text out of shell syntax, and keep even immediate startup errors in tmux history.
      const command = `/bin/bash -c ${shellQuote(codexLaunchScript(input, imagePaths, settings))}`;
      await checkedShell(workspaceId, buildObservableSessionCommand({ requireExistingServer: true, session: session.tmuxSession, cwd: workspaceRoot, command, env: { HOME: "/home/atelier", CODEX_HOME: codexHome }, remainOnExit: true, passthrough: true, historyLimit: 10000 }));
    } catch (error) {
      await revokeAgentMcp(workspaceId, id);
      session.error = error instanceof Error ? error.message : String(error);
      store().write(workspaceId, { sessions: listCodexSessions(workspaceId) });
    }
    return id;
  });
}

export async function codexTerminalState(workspaceId: string, session: CodexSession): Promise<{ exists: boolean; ended: boolean; exitCode?: number }> {
  const result = await execWorkspaceShell(workspaceId, `tmux list-panes -t ${shellQuote(session.tmuxSession)} -F '#{pane_dead}:#{pane_dead_status}'`);
  if (result.exitCode === 1) return { exists: false, ended: true };
  if (result.exitCode !== 0) throw new AtelierCoreError("codex_session_check_failed", result.stderr.trim() || "Could not inspect Codex terminal");
  const [dead, status] = result.stdout.trim().split(":");
  return { exists: true, ended: dead === "1", exitCode: status ? Number(status) : undefined };
}

export function closeCodexSession(workspaceId: string, id: string): Promise<void> {
  return serialize(workspaceId, async () => {
    const session = codexSession(workspaceId, id);
    await revokeAgentMcp(workspaceId, id);
    if ((await codexTerminalState(workspaceId, session)).exists) await checkedShell(workspaceId, `tmux kill-session -t ${shellQuote(session.tmuxSession)}`);
    store().write(workspaceId, { sessions: listCodexSessions(workspaceId).filter((session) => session.id !== id) });
  });
}
