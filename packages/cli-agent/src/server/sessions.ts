import { dirname } from "node:path";
import { prepareAgentMcp, revokeAgentMcp } from "@atelier/agent/server";
import { AtelierCoreError, createKeyedOperationQueue, shellQuote } from "@atelier/core";
import { buildObservableSessionCommand } from "@atelier/observable-terminal/server";
import { imageMimeByExtension } from "@atelier/prompt/server";
import type { AgentWorkspaceParameters, WorkspaceAgentInput } from "@atelier/shared";
import { createWorkspaceMetadataState, execWorkspaceShell, workspaceRoot } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { CliAgentAdapter } from "./adapter.ts";

const inputSchema = Type.Object({ text: Type.String(), images: Type.Array(Type.Object({ mimeType: Type.String(), data: Type.String() })), attachmentNotes: Type.Array(Type.String()) });
const sessionSchema = Type.Object({
  id: Type.String(), title: Type.String(), tmuxSession: Type.String(), input: inputSchema,
  // Older Codex tabs have no kind. Reading them must never execute their saved prompts.
  kind: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()), thinkingLevel: Type.Optional(Type.String()),
});
const stateSchema = Type.Object({ sessions: Type.Array(sessionSchema) });
type CliSession = Static<typeof sessionSchema>;

async function checkedShell(workspaceId: string, command: string, stdin?: string): Promise<void> {
  const result = await execWorkspaceShell(workspaceId, command, { stdin });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Command failed (exit ${result.exitCode})`);
}

export function createCliSessions(adapter: CliAgentAdapter) {
  let state: ReturnType<typeof createStore> | undefined;
  function createStore() { return createWorkspaceMetadataState(`${adapter.id}-agents.json`, (value) => Value.Parse(stateSchema, value), () => ({ sessions: [] })); }
  function store() { return state ??= createStore(); }
  const serialize = createKeyedOperationQueue();
  // Runtime readiness is separate from the durable claim. After a host restart,
  // inspect tmux; never replay a claimed initial prompt.
  const starting = new Map<string, Promise<void>>();

  function list(workspaceId: string): CliSession[] { return store().read(workspaceId).sessions; }
  function get(workspaceId: string, id: string): CliSession {
    const session = list(workspaceId).find((session) => session.id === id);
    if (!session) throw new AtelierCoreError("agent_conversation_not_found", `${adapter.label} conversation not found: ${id}`);
    return session;
  }

  // Called only inside the workspace queue, including the provisioning claim check.
  async function launch(workspaceId: string, input: WorkspaceAgentInput, settings: AgentWorkspaceParameters): Promise<string> {
    await adapter.requireSetup();
    const id = crypto.randomUUID();
    const session: CliSession = { id, title: input.text.trim().split("\n")[0]?.slice(0, 64) || adapter.label, tmuxSession: `${adapter.id}-${id}`, input, kind: adapter.id, model: settings.model, thinkingLevel: settings.thinkingLevel };
    // Claim before side effects. Recovery must never submit the initial prompt twice.
    store().write(workspaceId, { sessions: [...list(workspaceId), session] });
    const ready = Promise.withResolvers<void>();
    starting.set(id, ready.promise);
    try {
      await adapter.prepareWorkspace?.(workspaceId);
      const directory = `${workspaceRoot}/.atelier-attachments/${adapter.id}-${id}`;
      const imagePaths: string[] = [];
      for (const [index, image] of input.images.entries()) {
        const extension = Object.entries(imageMimeByExtension).find(([, mime]) => mime === image.mimeType)?.[0];
        if (!extension) throw new Error(`Unsupported image type: ${image.mimeType}`);
        const path = `${directory}/${index}.${extension}`;
        await checkedShell(workspaceId, `mkdir -p ${shellQuote(directory)} && base64 -d > ${shellQuote(path)}`, image.data);
        imagePaths.push(path);
      }
      const mcp = await prepareAgentMcp(workspaceId, id);
      const turnFinishedCommand = `/home/atelier/.local/share/atelier-agents/${id}/turn-finished.sh`;
      await checkedShell(workspaceId, `umask 077; mkdir -p ${shellQuote(dirname(turnFinishedCommand))} && cat > ${shellQuote(turnFinishedCommand)}`, `#!/bin/sh
exec curl --noproxy '*' --fail --silent --show-error --max-time 10 -X POST -H ${shellQuote("Authorization: Bearer " + mcp.token)} ${shellQuote(new URL("/agent-turn-finished", mcp.url).href)}
`);
      const env = { HOME: "/home/atelier", ...await adapter.prepareSession?.(workspaceId, id, mcp) };
      const command = `/bin/bash -c ${shellQuote(adapter.launchScript(input, imagePaths, settings, turnFinishedCommand))}`;
      await checkedShell(workspaceId, buildObservableSessionCommand({ requireExistingServer: true, session: session.tmuxSession, cwd: workspaceRoot, command, env, remainOnExit: true, passthrough: true, historyLimit: 10000 }));
    } catch (error) {
      // Startup failure is durable session state, shown in its tab rather than discarded.
      session.error = error instanceof Error ? error.message : String(error);
      store().write(workspaceId, { sessions: list(workspaceId) });
      await revokeAgentMcp(workspaceId, id);
    } finally {
      starting.delete(id);
      ready.resolve();
    }
    return id;
  }

  function create(workspaceId: string, settings: AgentWorkspaceParameters = {}): Promise<string> {
    return serialize(workspaceId, () => launch(workspaceId, settings.input ?? { text: "", images: [], attachmentNotes: [] }, settings));
  }
  function prepareWorkspace(workspaceId: string, settings: AgentWorkspaceParameters = {}): Promise<void> {
    return serialize(workspaceId, async () => {
      if (!list(workspaceId).length) await launch(workspaceId, settings.input ?? { text: "", images: [], attachmentNotes: [] }, settings);
    });
  }
  async function ready(workspaceId: string, id: string): Promise<CliSession> {
    get(workspaceId, id);
    await starting.get(id);
    return get(workspaceId, id);
  }
  async function terminalState(workspaceId: string, session: CliSession): Promise<{ starting?: boolean; exists: boolean; ended: boolean; exitCode?: number }> {
    if (starting.has(session.id)) return { starting: true, exists: false, ended: false };
    const result = await execWorkspaceShell(workspaceId, `tmux list-panes -t ${shellQuote(session.tmuxSession)} -F '#{pane_dead}:#{pane_dead_status}'`);
    if (result.exitCode === 1) return { exists: false, ended: true };
    if (result.exitCode !== 0) throw new AtelierCoreError(`${adapter.id}_session_check_failed`, result.stderr.trim() || `Could not inspect ${adapter.label} terminal`);
    const [dead, status] = result.stdout.trim().split(":");
    return { exists: true, ended: dead === "1", exitCode: status ? Number(status) : undefined };
  }
  function close(workspaceId: string, id: string): Promise<void> {
    return serialize(workspaceId, async () => {
      const session = get(workspaceId, id);
      await revokeAgentMcp(workspaceId, id);
      if ((await terminalState(workspaceId, session)).exists) await checkedShell(workspaceId, `tmux kill-session -t ${shellQuote(session.tmuxSession)}`);
      store().write(workspaceId, { sessions: list(workspaceId).filter((session) => session.id !== id) });
    });
  }
  return { list, get, ready, create, prepareWorkspace, terminalState, close };
}

export type CliSessions = ReturnType<typeof createCliSessions>;
