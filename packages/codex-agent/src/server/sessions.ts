import { AtelierCoreError, createKeyedOperationQueue, shellQuote } from "@atelier/core";
import { buildObservableSessionCommand } from "@atelier/observable-terminal/server";
import type { WorkspaceAgentInput } from "@atelier/shared";
import { createWorkspaceMetadataState, execWorkspaceShell, workspaceRoot } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const inputSchema = Type.Object({ text: Type.String(), images: Type.Array(Type.Object({ mimeType: Type.String(), data: Type.String() })), attachmentNotes: Type.Array(Type.String()) });
const sessionSchema = Type.Object({ id: Type.String(), title: Type.String(), tmuxSession: Type.String(), input: inputSchema });
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

export function createCodexSession(workspaceId: string, input: WorkspaceAgentInput = { text: "", images: [], attachmentNotes: [] }): Promise<string> {
  return serialize(workspaceId, async () => {
    const id = crypto.randomUUID();
    const tmuxSession = `codex-${id}`;
    const command = `/bin/bash -lc ${shellQuote("printf '\\033[36mCodex placeholder — interactive shell only. No agent is running.\\033[0m\\n'; exec /bin/bash")}`;
    const result = await execWorkspaceShell(workspaceId, buildObservableSessionCommand({ session: tmuxSession, cwd: workspaceRoot, command, passthrough: true, historyLimit: 10000 }));
    if (result.exitCode !== 0) throw new AtelierCoreError("codex_create_failed", result.stderr.trim() || "Could not start Codex placeholder terminal");
    const sessions = listCodexSessions(workspaceId);
    const title = input.text.trim().split("\n")[0]?.slice(0, 64) || "Codex placeholder";
    store().write(workspaceId, { sessions: [...sessions, { id, title, tmuxSession, input }] });
    return id;
  });
}

export async function codexSessionAlive(workspaceId: string, session: CodexSession): Promise<boolean> {
  const result = await execWorkspaceShell(workspaceId, `tmux has-session -t ${shellQuote(session.tmuxSession)}`);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new AtelierCoreError("codex_session_check_failed", result.stderr.trim() || "Could not inspect Codex terminal");
}

export function closeCodexSession(workspaceId: string, id: string): Promise<void> {
  return serialize(workspaceId, async () => {
    const session = codexSession(workspaceId, id);
    if (await codexSessionAlive(workspaceId, session)) {
      const result = await execWorkspaceShell(workspaceId, `tmux kill-session -t ${shellQuote(session.tmuxSession)}`);
      if (result.exitCode !== 0) throw new AtelierCoreError("codex_close_failed", result.stderr.trim() || "Could not close Codex terminal");
    }
    store().write(workspaceId, { sessions: listCodexSessions(workspaceId).filter((session) => session.id !== id) });
  });
}
