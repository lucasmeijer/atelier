import { dirname, posix } from "node:path";
import { execWorkspaceCommand, execWorkspaceShell } from "@atelier/core";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const workspaceRoot = "/repos";
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

export function createWorkspaceAgentTools(workspaceId: string): ToolDefinition<any, any>[] {
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
  const bash = createBashToolDefinition(workspaceRoot, {
    operations: {
      exec: async (command, _cwd, options) => {
        const result = await execWorkspaceShell(workspaceId, command, { workdir: workspaceRoot });
        const output = `${result.stdout}${result.stderr}`;
        if (output) options.onData(Buffer.from(output));
        return { exitCode: result.exitCode };
      },
    },
  });
  return [read, write, edit, bash];
}
