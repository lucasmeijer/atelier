import { dirname, posix } from "node:path";
import type { AtelierEventBus } from "@atelier/core";
import { execWorkspaceCommand, execWorkspaceShell, workspaceRoot } from "@atelier/workspace";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createTmuxBashTool } from "./bash-tmux.ts";

const maxReadBytes = 200_000;

export function normalizeWorkspacePath(path: string): string {
  if (!path || path.includes("\0")) throw new Error("path is required");
  const absolute = path.startsWith("/") ? posix.normalize(path) : posix.normalize(posix.join(workspaceRoot, path));
  if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}/`)) {
    throw new Error(`path escapes workspace root: ${path}`);
  }
  return absolute;
}

export function applyExactEdits(content: string, edits: Array<{ oldText: string; newText: string }>): string {
  const ranges: Array<{ start: number; end: number; newText: string }> = [];
  for (const edit of edits) {
    if (!edit.oldText) throw new Error("oldText must not be empty");
    const first = content.indexOf(edit.oldText);
    if (first === -1) throw new Error(`oldText not found: ${edit.oldText.slice(0, 80)}`);
    if (content.indexOf(edit.oldText, first + edit.oldText.length) !== -1) throw new Error(`oldText is not unique: ${edit.oldText.slice(0, 80)}`);
    ranges.push({ start: first, end: first + edit.oldText.length, newText: edit.newText });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i].start < ranges[i - 1].end) throw new Error("edits overlap");
  }
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    result += content.slice(cursor, range.start) + range.newText;
    cursor = range.end;
  }
  return result + content.slice(cursor);
}

async function readFileBuffer(workspaceId: string, absolutePath: string): Promise<Buffer> {
  const result = await execWorkspaceCommand(workspaceId, ["head", "-c", String(maxReadBytes + 1), absolutePath]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `could not read ${absolutePath}`);
  return Buffer.from(result.stdout);
}

async function writeFile(workspaceId: string, absolutePath: string, content: string): Promise<void> {
  const dir = dirname(absolutePath);
  const result = await execWorkspaceShell(workspaceId, `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(absolutePath)}`, { stdin: content });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `could not write ${absolutePath}`);
}

async function accessFile(workspaceId: string, absolutePath: string): Promise<void> {
  const result = await execWorkspaceCommand(workspaceId, ["test", "-r", absolutePath]);
  if (result.exitCode !== 0) throw new Error(`file is not readable: ${absolutePath}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface WorkspaceAgentToolOptions {
  events?: AtelierEventBus;
}

export type WorkspaceAgentToolFactory = (workspaceId: string, options: WorkspaceAgentToolOptions) => ToolDefinition<any, any>;

const registeredWorkspaceAgentTools = new Map<string, WorkspaceAgentToolFactory>();

export function registerWorkspaceAgentTool(name: string, factory: WorkspaceAgentToolFactory): () => void {
  registeredWorkspaceAgentTools.set(name, factory);
  return () => {
    if (registeredWorkspaceAgentTools.get(name) === factory) registeredWorkspaceAgentTools.delete(name);
  };
}

export function workspaceAgentToolNames(): string[] {
  return ["read", "write", "edit", "bash", ...registeredWorkspaceAgentTools.keys()];
}

export interface DeleteCurrentWorkspaceResult {
  deleted: boolean;
  blocked: boolean;
  details?: unknown;
}

export function createDeleteCurrentWorkspaceTool(workspaceId: string, deleteCurrentWorkspace: (force: boolean) => Promise<DeleteCurrentWorkspaceResult>): ToolDefinition<any, any> {
  return defineTool({
    name: "delete_current_workspace",
    label: "Delete Current Workspace",
    description: "Permanently delete this agent's current Atelier workspace. This tears down the execution context the agent has been doing all of its work in, including the workspace container and local files/changes that have not been preserved elsewhere. The agent cannot choose another workspace; this tool always deletes only its own current workspace. Execute this only when the user has explicitly requested deletion of this workspace.",
    parameters: Type.Object({
      force: Type.Boolean({
        description: "Set to false to run the existing workspace delete safety checks and report outstanding local changes instead of deleting when they are present. Set to true only when the user explicitly requested force deletion.",
      }),
    }),
    execute: async (_toolCallId: string, params: { force: boolean }) => {
      const result = await deleteCurrentWorkspace(params.force);
      if (result.blocked) {
        return {
          content: [{ type: "text" as const, text: "Current workspace was not deleted because the delete safety checks found outstanding local changes or unpushed commits." }],
          details: { workspaceId, ...result },
        };
      }
      return {
        content: [{ type: "text" as const, text: `Current workspace ${workspaceId} deletion has been scheduled. The agent execution context is now being torn down.` }],
        details: { workspaceId, ...result },
      };
    },
  });
}

export function createWorkspaceAgentTools(workspaceId: string, options: WorkspaceAgentToolOptions = {}): ToolDefinition<any, any>[] {
  const read = createReadToolDefinition(workspaceRoot, {
    operations: {
      readFile: (path) => readFileBuffer(workspaceId, normalizeWorkspacePath(path)),
      access: (path) => accessFile(workspaceId, normalizeWorkspacePath(path)),
    },
  });
  const write = createWriteToolDefinition(workspaceRoot, {
    operations: {
      writeFile: (path, content) => writeFile(workspaceId, normalizeWorkspacePath(path), content),
      mkdir: async (path) => {
        const result = await execWorkspaceCommand(workspaceId, ["mkdir", "-p", normalizeWorkspacePath(path)]);
        if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `could not create ${path}`);
      },
    },
  });
  const edit = createEditToolDefinition(workspaceRoot, {
    operations: {
      readFile: (path) => readFileBuffer(workspaceId, normalizeWorkspacePath(path)),
      writeFile: (path, content) => writeFile(workspaceId, normalizeWorkspacePath(path), content),
      access: (path) => accessFile(workspaceId, normalizeWorkspacePath(path)),
    },
  });
  const bash = createTmuxBashTool(workspaceId);
  const external = [...registeredWorkspaceAgentTools.values()].map((factory) => factory(workspaceId, options));
  return [read, write, edit, bash, ...external];
}
