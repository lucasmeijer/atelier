import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { join, relative, sep } from "node:path";
import { parseDiffFromFile, type FileContents, type FileDiffMetadata } from "@pierre/diffs";
import type { ReviewSide } from "../model.ts";

const maxRenderedBytes = 1_000_000;
const maxRenderedLines = 5_000;

type ReviewFileKind = "text" | "binary" | "large" | "mode";

export interface ReviewFile {
  path: string;
  previousPath?: string;
  kind: ReviewFileKind;
  oldContents?: string;
  newContents?: string;
  diff?: FileDiffMetadata;
  additions: number;
  deletions: number;
  detail?: string;
}

export type ReviewSnapshot =
  | { phase: "not-git" }
  | { phase: "ready"; files: ReviewFile[] };

interface StatusEntry {
  code: string;
  path: string;
  previousPath?: string;
}

interface GitResult { stdout: Buffer; stderr: string; exitCode: number }

async function gitResult(root: string, args: string[]): Promise<GitResult> {
  const process = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout: Buffer.from(stdout), stderr, exitCode };
}

async function git(root: string, args: string[], allowFailure = false): Promise<Buffer> {
  const result = await gitResult(root, args);
  if (result.exitCode !== 0 && !allowFailure) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.exitCode === 0 ? result.stdout : Buffer.alloc(0);
}

function parseStatus(output: Buffer): StatusEntry[] {
  const fields = output.toString("utf8").split("\0");
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const field = fields[index++];
    if (!field) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code.includes("R") || code.includes("C")) {
      const previousPath = fields[index++];
      const entry: StatusEntry = { code, path };
      if (previousPath) entry.previousPath = previousPath;
      entries.push(entry);
    } else {
      entries.push({ code, path });
    }
  }
  return entries;
}

async function gitObject(root: string, path: string): Promise<Buffer | undefined> {
  const result = await gitResult(root, ["show", `HEAD:${path}`]);
  return result.exitCode === 0 ? result.stdout : undefined;
}

async function workingFile(root: string, path: string): Promise<Buffer | undefined> {
  const absolute = join(root, path);
  const resolved = relative(root, absolute);
  if (resolved.startsWith(`..${sep}`) || resolved === "..") throw new Error(`review path escapes repository: ${path}`);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return Buffer.from(await readlink(absolute));
    if (!info.isFile()) return undefined;
    return await readFile(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function decodeText(content: Buffer | undefined): string | undefined {
  if (content === undefined || content.includes(0) || !isUtf8(content)) return undefined;
  return content.toString("utf8");
}

function lineCount(text: string | undefined): number {
  if (!text) return 0;
  return text.split("\n").length;
}

interface ChangeCounts { additions: number; deletions: number }

function countChanges(diff: FileDiffMetadata): ChangeCounts {
  let additions = 0;
  let deletions = 0;
  for (const hunk of diff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

async function modes(root: string, entry: StatusEntry): Promise<{ oldMode?: string; newMode?: string }> {
  const raw = (await git(root, ["diff", "--raw", "HEAD", "--", entry.path], true)).toString("utf8").trim();
  const match = raw.match(/^:(\d{6}) (\d{6}) /);
  if (match) return { oldMode: match[1], newMode: match[2] };
  if (entry.code === "??") {
    const info = await lstat(join(root, entry.path));
    return { newMode: info.isSymbolicLink() ? "120000" : info.mode & 0o111 ? "100755" : "100644" };
  }
  return {};
}

async function reviewFile(root: string, entry: StatusEntry): Promise<ReviewFile | undefined> {
  const oldPath = entry.previousPath ?? entry.path;
  const [oldBuffer, newBuffer, fileModes] = await Promise.all([
    entry.code === "??" ? undefined : gitObject(root, oldPath),
    workingFile(root, entry.path),
    modes(root, entry),
  ]);
  const oldText = decodeText(oldBuffer);
  const newText = decodeText(newBuffer);
  const base: Pick<ReviewFile, "path" | "previousPath"> = { path: entry.path };
  if (entry.previousPath) base.previousPath = entry.previousPath;
  if (oldBuffer === undefined && newBuffer === undefined) {
    if (fileModes.oldMode === "160000" || fileModes.newMode === "160000") return { ...base, kind: "mode", additions: 0, deletions: 0, detail: "Submodule changed" };
    return undefined;
  }

  if ((oldBuffer && oldText === undefined) || (newBuffer && newText === undefined)) {
    return { ...base, kind: "binary", additions: 0, deletions: 0, detail: "Binary file changed" };
  }
  if ((oldBuffer?.byteLength ?? 0) > maxRenderedBytes || (newBuffer?.byteLength ?? 0) > maxRenderedBytes || lineCount(oldText) > maxRenderedLines || lineCount(newText) > maxRenderedLines) {
    return { ...base, kind: "large", additions: 0, deletions: 0, detail: "File is too large to render safely" };
  }

  const oldFile: FileContents | null = oldBuffer === undefined ? null : { name: oldPath, contents: oldText ?? "" };
  const newFile: FileContents | null = newBuffer === undefined ? null : { name: entry.path, contents: newText ?? "" };
  const diff = parseDiffFromFile(oldFile, newFile, { context: 3 });
  const counts = countChanges(diff);
  if (diff.hunks.length === 0) {
    const detail = entry.previousPath
      ? "File renamed"
      : oldBuffer === undefined
        ? "Empty file added"
        : newBuffer === undefined
          ? "Empty file deleted"
          : fileModes.oldMode !== fileModes.newMode
            ? "File mode changed"
            : "No textual changes";
    return { ...base, kind: "mode", ...counts, detail };
  }
  return { ...base, kind: "text", oldContents: oldText, newContents: newText, diff, ...counts };
}

export async function collectReviewSnapshot(root: string): Promise<ReviewSnapshot> {
  try {
    await stat(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { phase: "not-git" };
    throw error;
  }
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"], true);
  if (inside.toString("utf8").trim() !== "true") return { phase: "not-git" };
  const entries = parseStatus(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const reviewed = await Promise.all(entries.map((entry) => reviewFile(root, entry)));
  const files = reviewed.filter((file): file is ReviewFile => file !== undefined).sort((a, b) => a.path.localeCompare(b.path));
  return { phase: "ready", files };
}

export function reviewSnippet(file: ReviewFile, side: ReviewSide, startLine: number, endLine: number): string {
  const text = side === "additions" ? file.newContents : file.oldContents;
  if (text === undefined) return "";
  return text.split("\n").slice(startLine - 1, endLine).join("\n");
}
