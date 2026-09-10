import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AtelierCoreError, atelierDataPath, getAtelierRuntimeContext, shellQuote } from "@atelier/core";
import { buildKillSessionCommand, buildListSessionsCommand, buildObservableSessionCommand } from "@atelier/observable-terminal/server";
import { execWorkspaceShell, workspaceRoot } from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { newInteractiveTerminalCommand } from "./terminal-intro.ts";

const workspaceTerminalSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  tmuxSession: Type.String(),
  sessionRelationship: Type.Union([Type.Literal("owned"), Type.Literal("attached")]),
});
const workspaceTerminalsSchema = Type.Array(workspaceTerminalSchema);
const workspaceTerminalHistoryLimit = 10_000;

export type WorkspaceTerminal = Static<typeof workspaceTerminalSchema>;

interface TmuxSessionMetadata {
  name: string;
  createdAt: number;
  lastActivityAt: number;
  command: string;
}

interface WorkspaceTerminalCreateOptions {
  /** Preferred Terminal view and tmux session title. If already used, a numeric suffix is added. */
  title?: string;
  command?: string;
  cwd?: string;
}

function statePath(workspaceId: string): string {
  return atelierDataPath(getAtelierRuntimeContext(), "workspaces", workspaceId, "metadata", "terminals.json");
}

async function writeTerminals(workspaceId: string, terminals: WorkspaceTerminal[]): Promise<void> {
  const path = statePath(workspaceId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(terminals, null, 2)}\n`);
  await rename(temporary, path);
}

export async function listTmuxSessions(workspaceId: string): Promise<TmuxSessionMetadata[]> {
  const separator = "\u001f";
  const format = ["#{session_name}", "#{session_created}", "#{session_activity}", "#{pane_current_command}"].join(separator);
  const result = await execWorkspaceShell(workspaceId, buildListSessionsCommand(format));
  if (result.exitCode !== 0) return [];

  return result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [name, createdAt, lastActivityAt, command] = line.split(separator);
    return {
      name: name!,
      createdAt: Number(createdAt),
      lastActivityAt: Number(lastActivityAt),
      command: command!,
    };
  });
}

export async function tmuxSessionExists(workspaceId: string, name: string): Promise<boolean> {
  return (await listTmuxSessions(workspaceId)).some((session) => session.name === name);
}

export async function listWorkspaceTerminals(workspaceId: string): Promise<WorkspaceTerminal[]> {
  try {
    return Value.Parse(workspaceTerminalsSchema, JSON.parse(await readFile(statePath(workspaceId), "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await writeTerminals(workspaceId, []);
    return [];
  }
}

function availableTitle(existingTitles: string[], preferred?: string): string {
  const existing = new Set(existingTitles);
  const base = preferred?.trim() || "Terminal";
  if (base !== "Terminal" && !existing.has(base)) return base;
  let index = 1;
  while (existing.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function normalizeCwd(cwd?: string): string {
  const value = cwd?.trim() || workspaceRoot;
  if (value !== workspaceRoot && !value.startsWith(`${workspaceRoot}/`)) {
    throw new AtelierCoreError("terminal_invalid_cwd", `terminal cwd must be under ${workspaceRoot}: ${value}`);
  }
  return value;
}

async function sessionCommand(command?: string): Promise<{ setup: string; command: string }> {
  const trimmed = command?.trim();
  if (!trimmed) return newInteractiveTerminalCommand();
  const script = `${trimmed}\nstatus=$?\nprintf '\\n[process exited with code %s]\\n' "$status"\nexec /bin/bash`;
  return { setup: "", command: `/bin/bash -lc ${shellQuote(script)}` };
}

function newTerminal(terminals: WorkspaceTerminal[], title: string, tmuxSession: string, sessionRelationship: WorkspaceTerminal["sessionRelationship"]): WorkspaceTerminal {
  const terminal = { id: crypto.randomUUID(), title: availableTitle(terminals.map((item) => item.title), title), tmuxSession, sessionRelationship };
  terminals.push(terminal);
  return terminal;
}

export async function createWorkspaceTerminal(workspaceId: string, options: WorkspaceTerminalCreateOptions = {}): Promise<WorkspaceTerminal> {
  const terminals = await listWorkspaceTerminals(workspaceId);
  const sessions = await listTmuxSessions(workspaceId);
  const tmuxSession = availableTitle(sessions.map((session) => session.name), options.title);
  const launch = await sessionCommand(options.command);
  const result = await execWorkspaceShell(workspaceId, `${launch.setup}\n${buildObservableSessionCommand({
    session: tmuxSession,
    cwd: normalizeCwd(options.cwd),
    command: launch.command,
    passthrough: true,
    status: false,
    historyLimit: workspaceTerminalHistoryLimit,
  })}`);
  if (result.exitCode !== 0) throw new AtelierCoreError("terminal_create_failed", result.stderr.trim() || `could not create terminal: ${tmuxSession}`);

  const terminal = newTerminal(terminals, options.title?.trim() || "Terminal", tmuxSession, "owned");
  await writeTerminals(workspaceId, terminals);
  return terminal;
}

export async function attachWorkspaceTerminal(workspaceId: string, tmuxSession: string): Promise<WorkspaceTerminal> {
  if (!(await tmuxSessionExists(workspaceId, tmuxSession))) {
    throw new AtelierCoreError("terminal_not_found", `tmux session not found: ${tmuxSession}`);
  }
  const terminals = await listWorkspaceTerminals(workspaceId);
  const terminal = newTerminal(terminals, tmuxSession, tmuxSession, "attached");
  await writeTerminals(workspaceId, terminals);
  return terminal;
}

export async function deleteWorkspaceTerminal(workspaceId: string, terminalId: string): Promise<void> {
  const terminals = await listWorkspaceTerminals(workspaceId);
  const index = terminals.findIndex((terminal) => terminal.id === terminalId);
  if (index < 0) throw new AtelierCoreError("terminal_not_found", `terminal not found: ${terminalId}`);
  const [terminal] = terminals.splice(index, 1);
  if (terminal!.sessionRelationship === "owned") {
    const result = await execWorkspaceShell(workspaceId, buildKillSessionCommand(terminal!.tmuxSession));
    if (result.exitCode !== 0) throw new AtelierCoreError("terminal_close_failed", result.stderr.trim() || `could not close terminal session: ${terminal!.tmuxSession}`);
  }
  await writeTerminals(workspaceId, terminals);
}
