import { posix } from "node:path";
import { execWorkspaceCommand, execWorkspaceCommandBuffer, workspaceRoot } from "@atelier/workspace";

export interface FileEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size: number;
  concealed: boolean;
}

export class FilesPathError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function normalizeFilesPath(input: string | null): string {
  const path = posix.resolve(workspaceRoot, input || workspaceRoot);
  if (path !== workspaceRoot && !path.startsWith(`${workspaceRoot}/`)) throw new FilesPathError("Path is outside the workspace", 403);
  return path;
}

export async function resolveFilesDirectory(workspaceId: string, input: string | null): Promise<string> {
  const requested = normalizeFilesPath(input);
  const result = await execWorkspaceCommandBuffer(workspaceId, ["sh", "-c", "test -d \"$1\" && realpath -ez -- \"$1\"", "sh", requested]);
  if (result.exitCode !== 0) throw new FilesPathError("Folder not found", 404);
  const path = result.stdout.subarray(0, -1).toString("utf8");
  if (path !== workspaceRoot && !path.startsWith(`${workspaceRoot}/`)) throw new FilesPathError("Path is outside the workspace", 403);
  return path;
}

function parseFindOutput(stdout: Buffer, directory: string): Omit<FileEntry, "concealed">[] {
  const fields = stdout.toString("utf8").split("\0");
  const entries: Omit<FileEntry, "concealed">[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [type, sizeText, name] = fields.slice(index, index + 3) as [string, string, string];
    if (!name) continue;
    const kind = type === "d" ? "directory" : type === "f" ? "file" : type === "l" ? "symlink" : "other";
    entries.push({ name, path: posix.join(directory, name), kind, size: Number(sizeText) });
  }
  return entries;
}

async function ignoredPaths(workspaceId: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const result = await execWorkspaceCommand(workspaceId, ["git", "-C", workspaceRoot, "check-ignore", "--no-index", "-z", "--stdin"], {
    stdin: `${paths.join("\0")}\0`,
  });
  if (result.exitCode !== 0 && result.exitCode !== 1 && !result.stderr.includes("not a git repository")) throw new Error(result.stderr.trim());
  return new Set(result.stdout.split("\0").filter(Boolean).map((path) => posix.resolve(workspaceRoot, path)));
}

export async function listFiles(workspaceId: string, inputPath: string | null, showConcealed: boolean): Promise<{ path: string; entries: FileEntry[] }> {
  const path = await resolveFilesDirectory(workspaceId, inputPath);
  const listing = await execWorkspaceCommandBuffer(workspaceId, ["find", path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%y\\0%s\\0%f\\0"]);
  if (listing.exitCode !== 0) throw new FilesPathError(listing.stderr.trim() || "Unable to read folder", 403);
  const rawEntries = parseFindOutput(listing.stdout, path);
  const ignored = await ignoredPaths(workspaceId, rawEntries.map((entry) => entry.path));
  const entries = rawEntries
    .map((entry) => ({ ...entry, concealed: entry.name.startsWith(".") || ignored.has(entry.path) }))
    .filter((entry) => showConcealed || !entry.concealed)
    .sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name));
  return { path, entries };
}

export async function deleteFile(workspaceId: string, inputPath: string | null): Promise<string> {
  const requested = normalizeFilesPath(inputPath);
  if (requested === workspaceRoot) throw new FilesPathError("The workspace root cannot be deleted", 422);

  const directory = await resolveFilesDirectory(workspaceId, posix.dirname(requested));
  const target = posix.join(directory, posix.basename(requested));
  const script = `if ! test -e "$1" && ! test -L "$1"; then exit 44; fi
rm -rf -- "$1"`;
  const result = await execWorkspaceCommand(workspaceId, ["sh", "-c", script, "sh", target]);
  if (result.exitCode === 44) throw new FilesPathError("File or folder not found", 404);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Delete failed");
  return directory;
}

export async function uploadFile(workspaceId: string, inputDirectory: string | null, name: string | null, overwrite: boolean, content: Uint8Array): Promise<void> {
  const directory = await resolveFilesDirectory(workspaceId, inputDirectory);
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) throw new FilesPathError("Invalid file name", 422);

  const target = posix.join(directory, name);
  const temporary = posix.join(directory, `.atelier-upload-${crypto.randomUUID()}`);
  const script = `set -e
umask 022
trap 'rm -f -- "$1"' EXIT
cat > "$1"
if test -L "$2" || test -d "$2"; then exit 65; fi
if test "$3" != 1 && test -e "$2"; then exit 66; fi
mv -fT -- "$1" "$2"`;
  const result = await execWorkspaceCommand(workspaceId, ["sh", "-c", script, "sh", temporary, target, overwrite ? "1" : "0"], { stdin: content });
  if (result.exitCode === 65) throw new FilesPathError("A folder or symlink already uses that name", 422);
  if (result.exitCode === 66) throw new FilesPathError("File already exists", 409);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Upload failed");
}
