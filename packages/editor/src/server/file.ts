import { createHash } from "node:crypto";
import { posix } from "node:path";
import { execWorkspaceCommand, execWorkspaceCommandBuffer, workspaceRoot } from "@atelier/workspace";

export const maxEditableFileBytes = 2_000_000;

export interface EditableFile {
  path: string;
  content: string;
  revision: string;
  writable: boolean;
}

export class EditorFileError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function requestedEditableFilePath(input: string | null): string {
  const path = posix.resolve(workspaceRoot, input || workspaceRoot);
  if (path === workspaceRoot) throw new EditorFileError("Choose a text file to edit", 422);
  return path;
}

function revision(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function editableTarget(workspaceId: string, inputPath: string | null): Promise<string> {
  const requested = requestedEditableFilePath(inputPath);
  const parent = posix.dirname(requested);
  const result = await execWorkspaceCommandBuffer(workspaceId, ["sh", "-c", "test -d \"$1\" && realpath -ez -- \"$1\"", "sh", parent]);
  if (result.exitCode !== 0) throw new EditorFileError("Folder not found", 404);
  const directory = result.stdout.subarray(0, -1).toString("utf8");
  return posix.join(directory, posix.basename(requested));
}

export async function readEditableFile(workspaceId: string, inputPath: string | null): Promise<EditableFile> {
  const path = await editableTarget(workspaceId, inputPath);
  const script = `if ! test -e "$1"; then exit 44; fi
if test -L "$1" || ! test -f "$1"; then exit 45; fi
size=$(stat -c %s -- "$1")
if test "$size" -gt "$2"; then exit 46; fi
if test -w "$1"; then printf '1\\0'; else printf '0\\0'; fi
cat -- "$1"`;
  const result = await execWorkspaceCommandBuffer(workspaceId, ["sh", "-c", script, "sh", path, String(maxEditableFileBytes)]);
  if (result.exitCode === 44) throw new EditorFileError("File not found", 404);
  if (result.exitCode === 45) throw new EditorFileError("Only regular files can be edited", 422);
  if (result.exitCode === 46) throw new EditorFileError("Files larger than 2 MB cannot be edited", 413);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to read file");
  const separator = result.stdout.indexOf(0);
  const writable = result.stdout.subarray(0, separator).toString("utf8") === "1";
  const bytes = result.stdout.subarray(separator + 1);
  if (bytes.includes(0)) throw new EditorFileError("Only text files can be edited", 415);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EditorFileError("Only UTF-8 text files can be edited", 415);
  }
  return { path, content, revision: revision(bytes), writable };
}

export async function writeEditableFile(workspaceId: string, inputPath: string | null, content: string, expectedRevision: string, force: boolean): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > maxEditableFileBytes) throw new EditorFileError("Files larger than 2 MB cannot be edited", 413);
  if (content.includes("\0")) throw new EditorFileError("Only text files can be edited", 415);
  const path = await editableTarget(workspaceId, inputPath);
  const temporary = posix.join(posix.dirname(path), `.atelier-edit-${crypto.randomUUID()}`);
  const script = `if ! test -e "$1"; then exit 44; fi
if test -L "$1" || ! test -f "$1"; then exit 45; fi
if ! test -w "$1"; then exit 47; fi
current=$(sha256sum -- "$1" | cut -d ' ' -f 1)
if test "$4" != 1 && test "$current" != "$3"; then exit 73; fi
trap 'rm -f -- "$2"' EXIT
cat > "$2"
chmod --reference="$1" -- "$2"
mv -fT -- "$2" "$1"`;
  const result = await execWorkspaceCommand(workspaceId, ["sh", "-c", script, "sh", path, temporary, expectedRevision, force ? "1" : "0"], { stdin: content });
  if (result.exitCode === 44) throw new EditorFileError("File not found", 404);
  if (result.exitCode === 45) throw new EditorFileError("Only regular files can be edited", 422);
  if (result.exitCode === 47) throw new EditorFileError("File is read-only", 403);
  if (result.exitCode === 73) throw new EditorFileError("File changed on disk", 409);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to save file");
  return revision(bytes);
}
