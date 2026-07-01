import { dirname, posix } from "node:path";
import { shellQuote, type AtelierEventBus } from "@atelier/core";
import type { AgentWorkspaceCreateRequest, AgentWorkspaceCreateResult, AgentWorkspaceForkRequest, WorkspaceLayoutPlacementController } from "@atelier/shared";
import { execWorkspaceCommand, execWorkspaceCommandBuffer, execWorkspaceShell, workspaceRoot } from "@atelier/workspace";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createTmuxBashTool } from "./bash-tmux.ts";

export function normalizeWorkspacePath(path: string): string {
  if (!path || path.includes("\0")) throw new Error("path is required");
  const absolute = path.startsWith("/") ? posix.normalize(path) : posix.normalize(posix.join(workspaceRoot, path));
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

const supportedImageMimeTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"]);

async function detectWorkspaceImageMimeType(workspaceId: string, absolutePath: string): Promise<string | null> {
  const result = await execWorkspaceCommand(workspaceId, ["file", "--brief", "--mime-type", absolutePath]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `could not inspect ${absolutePath}`);
  const mimeType = result.stdout.trim().toLowerCase();
  return supportedImageMimeTypes.has(mimeType) ? mimeType : null;
}

async function readFileBuffer(workspaceId: string, absolutePath: string): Promise<Buffer> {
  const result = await execWorkspaceCommandBuffer(workspaceId, ["cat", absolutePath]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `could not read ${absolutePath}`);
  return result.stdout;
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

interface WorkspaceAgentToolOptions {
  events?: AtelierEventBus;
}

export interface WorkspacePresenterDeps {
  events?: AtelierEventBus;
  getTabKeys(): Promise<string[]>;
  layouts: WorkspaceLayoutPlacementController;
}

type WorkspaceAgentToolFactory = (workspaceId: string, options: WorkspaceAgentToolOptions) => ToolDefinition<any, any>;

export interface WorkspacePresenterDefinition<Params extends { kind: string } = { kind: string }> {
  kind: Params["kind"];
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Params): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

type WorkspacePresenterFactory = (workspaceId: string, options: WorkspaceAgentToolOptions) => WorkspacePresenterDefinition<any>;

const registeredWorkspaceAgentTools = new Map<string, WorkspaceAgentToolFactory>();
const registeredWorkspacePresenters = new Map<string, WorkspacePresenterFactory>();

export function registerWorkspaceAgentTool(name: string, factory: WorkspaceAgentToolFactory): () => void {
  registeredWorkspaceAgentTools.set(name, factory);
  return () => {
    if (registeredWorkspaceAgentTools.get(name) === factory) registeredWorkspaceAgentTools.delete(name);
  };
}

export function registerWorkspacePresenter(kind: string, factory: WorkspacePresenterFactory): () => void {
  registeredWorkspacePresenters.set(kind, factory);
  return () => {
    if (registeredWorkspacePresenters.get(kind) === factory) registeredWorkspacePresenters.delete(kind);
  };
}

export function workspaceAgentToolNames(): string[] {
  return ["read", "write", "edit", "bash", ...(registeredWorkspacePresenters.size ? ["present"] : []), ...registeredWorkspaceAgentTools.keys()];
}

export interface DeleteCurrentWorkspaceResult {
  deleted: boolean;
  blocked: boolean;
  details?: unknown;
}

const agentWorkspaceParameterSchemas = {
  initialPrompt: Type.Optional(Type.String({
    description: "Optional prompt to send to the default agent in the new workspace after it is created.",
  })),
  model: Type.Optional(Type.String({
    description: "Optional model reference for the initial agent prompt.",
  })),
  thinkingLevel: Type.Optional(Type.String({
    description: "Optional thinking level for the initial agent prompt.",
  })),
  attachmentDraft: Type.Optional(Type.String({
    description: "Optional attachment draft id for the initial agent prompt.",
  })),
};

export function createWorkspaceTool(createWorkspace: (request: AgentWorkspaceCreateRequest) => Promise<AgentWorkspaceCreateResult>): ToolDefinition<any, any> {
  return defineTool({
    name: "create_workspace",
    label: "Create Workspace",
    description: "Create a new Atelier workspace.",
    parameters: Type.Object({
      seedWithCurrentProjectClone: Type.Boolean({
        description: "Seed the new workspace with a fresh git clone of the same project remote and branch that this workspace was originally seeded with. Local changes in this workspace are not included unless they have been pushed.",
      }),
      title: Type.Optional(Type.String({
        description: "Optional display title for the new workspace.",
      })),
      ...agentWorkspaceParameterSchemas,
    }),
    execute: async (_toolCallId: string, params: AgentWorkspaceCreateRequest) => {
      const result = await createWorkspace(params);
      return {
        content: [{ type: "text" as const, text: `Created workspace ${result.id}: ${result.url}` }],
        details: { workspace: result },
      };
    },
  });
}

export function createForkCurrentWorkspaceTool(forkCurrentWorkspace: (request: AgentWorkspaceForkRequest) => Promise<AgentWorkspaceCreateResult>): ToolDefinition<any, any> {
  return defineTool({
    name: "fork_current_workspace",
    label: "Fork Current Workspace",
    description: "Create a new Atelier workspace by copying the current workspace's /work directory into a fresh container based on the current workspace container image. The copy includes the entire /work folder, including unversioned files. This does not copy terminal sessions, tab layout, or agent conversation history. initialPrompt, when provided, runs in a new fresh agent context in the fork. For repository workspaces, the fork and this spawning workspace share /persistent and can use it as a communication channel.",
    parameters: Type.Object({
      title: Type.String({
        description: "Required display title for the forked workspace.",
      }),
      ...agentWorkspaceParameterSchemas,
    }),
    execute: async (_toolCallId: string, params: AgentWorkspaceForkRequest) => {
      const result = await forkCurrentWorkspace(params);
      return {
        content: [{ type: "text" as const, text: `Forked current workspace into ${result.id}: ${result.url}` }],
        details: { workspace: result },
      };
    },
  });
}

function createPresentTool(workspaceId: string, options: WorkspaceAgentToolOptions): ToolDefinition<any, any> | undefined {
  const presenters = [...registeredWorkspacePresenters.values()].map((factory) => factory(workspaceId, options));
  if (!presenters.length) return undefined;
  return defineTool({
    name: "present",
    label: "Present",
    description: "Present one primary interactive surface to the user in Atelier. Use this when there is one main thing the user should look at or interact with while evaluating your work. Atelier will place the chosen surface in the preview area. Calling this again should update or replace the primary presentation rather than adding multiple competing presentations. Only use this tool for interactive surfaces that need explicit presentation, currently a tmux session or the inline preview browser. Do not use this tool for static or inline artifacts. Images, videos, SVGs, and HTML files are already automatically visible to the user when you reference them with Atelier embed syntax, for example: {{atelier:embed /work/app/screenshot.png}} or {{atelier:embed /work/app/demo.html}}. For ordinary screenshots, videos, generated HTML explanations, or file previews, prefer the embed syntax instead of this tool.",
    parameters: Type.Union(presenters.map((presenter) => Type.Object({
      kind: Type.Literal(presenter.kind, { description: `Present ${presenter.kind}.` }),
      ...presenter.parameters,
    }, { description: presenter.description }))) as any,
    execute: async (toolCallId: string, params: { kind: string }) => {
      const presenter = presenters.find((candidate) => candidate.kind === params.kind);
      if (!presenter) throw new Error(`unknown presentation kind: ${params.kind}`);
      return await presenter.execute(toolCallId, params);
    },
  });
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
      detectImageMimeType: (path) => detectWorkspaceImageMimeType(workspaceId, normalizeWorkspacePath(path)),
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
  const present = createPresentTool(workspaceId, options);
  const external = [...registeredWorkspaceAgentTools.values()].map((factory) => factory(workspaceId, options));
  return [read, write, edit, bash, ...(present ? [present] : []), ...external];
}
