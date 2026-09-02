import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { join, relative, sep } from "node:path";
import { parseDiffFromFile, type FileContents, type FileDiffMetadata } from "@pierre/diffs";
import type { ReviewSide } from "../model.ts";

const maxRenderedBytes = 1_000_000;
const maxRenderedLines = 5_000;

type ReviewFileKind = "text" | "binary" | "large" | "mode";
type ReviewFileChange = "added" | "modified" | "removed";

export interface ReviewFile {
  path: string;
  previousPath?: string;
  change: ReviewFileChange;
  kind: ReviewFileKind;
  oldContents?: string;
  newContents?: string;
  diff?: FileDiffMetadata;
  detail?: string;
}

export interface ReviewFileSummary {
  path: string;
  previousPath?: string;
  change: ReviewFileChange;
  untracked?: true;
}

export interface ReviewFileStats extends ReviewFileSummary, ChangeCounts {}

export type ReviewIndex =
  | { phase: "not-git" }
  | { phase: "ready"; files: ReviewFileSummary[] };

interface StatusEntry {
  code: string;
  path: string;
  previousPath?: string;
}

export interface GitResult { stdout: Buffer; stderr: string; exitCode: number }

export async function gitResult(root: string, args: string[]): Promise<GitResult> {
  const process = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout: Buffer.from(stdout), stderr, exitCode };
}

export async function git(root: string, args: string[], allowFailure = false): Promise<Buffer> {
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

function reviewFileFromContents(
  entry: StatusEntry,
  oldBuffer: Buffer | undefined,
  newBuffer: Buffer | undefined,
  noTextDetail: string,
): ReviewFile | undefined {
  const oldPath = entry.previousPath ?? entry.path;
  const change: ReviewFileChange = oldBuffer === undefined ? "added" : newBuffer === undefined ? "removed" : "modified";
  const base: Pick<ReviewFile, "path" | "previousPath" | "change"> = { path: entry.path, change };
  if (entry.previousPath) base.previousPath = entry.previousPath;
  if (oldBuffer === undefined && newBuffer === undefined) return undefined;
  const oldText = decodeText(oldBuffer);
  const newText = decodeText(newBuffer);
  if ((oldBuffer && oldText === undefined) || (newBuffer && newText === undefined)) return { ...base, kind: "binary", detail: "Binary file changed" };
  if ((oldBuffer?.byteLength ?? 0) > maxRenderedBytes || (newBuffer?.byteLength ?? 0) > maxRenderedBytes || lineCount(oldText) > maxRenderedLines || lineCount(newText) > maxRenderedLines) return { ...base, kind: "large", detail: "File is too large to render safely" };
  const oldFile: FileContents | null = oldBuffer === undefined ? null : { name: oldPath, contents: oldText ?? "" };
  const newFile: FileContents | null = newBuffer === undefined ? null : { name: entry.path, contents: newText ?? "" };
  const diff = parseDiffFromFile(oldFile, newFile, { context: 3 });
  return diff.hunks.length
    ? { ...base, kind: "text", oldContents: oldText, newContents: newText, diff }
    : { ...base, kind: "mode", detail: noTextDetail };
}

async function reviewFile(root: string, entry: StatusEntry): Promise<ReviewFile | undefined> {
  const oldPath = entry.previousPath ?? entry.path;
  const [oldBuffer, newBuffer, fileModes] = await Promise.all([
    entry.code === "??" ? undefined : gitObject(root, oldPath),
    workingFile(root, entry.path),
    modes(root, entry),
  ]);
  if (oldBuffer === undefined && newBuffer === undefined && (fileModes.oldMode === "160000" || fileModes.newMode === "160000")) {
    const base = { path: entry.path, change: "modified" as const };
    return entry.previousPath ? { ...base, previousPath: entry.previousPath, kind: "mode", detail: "Submodule changed" } : { ...base, kind: "mode", detail: "Submodule changed" };
  }
  const detail = entry.previousPath
    ? "File renamed"
    : oldBuffer === undefined
      ? "Empty file added"
      : newBuffer === undefined
        ? "Empty file deleted"
        : fileModes.oldMode !== fileModes.newMode
          ? "File mode changed"
          : "No textual changes";
  return reviewFileFromContents(entry, oldBuffer, newBuffer, detail);
}

async function statusEntries(root: string): Promise<StatusEntry[] | undefined> {
  try {
    await stat(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"], true);
  if (inside.toString("utf8").trim() !== "true") return undefined;
  return parseStatus(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
}

function statusChange(entry: StatusEntry): ReviewFileChange {
  if (entry.code === "??" || entry.code.includes("A")) return "added";
  if (entry.code.includes("D")) return "removed";
  return "modified";
}

export async function collectReviewIndex(root: string): Promise<ReviewIndex> {
  const entries = await statusEntries(root);
  if (!entries) return { phase: "not-git" };
  const files = entries.map((entry): ReviewFileSummary => {
    const file: ReviewFileSummary = { path: entry.path, change: statusChange(entry) };
    if (entry.previousPath) file.previousPath = entry.previousPath;
    if (entry.code === "??") file.untracked = true;
    return file;
  }).sort((a, b) => a.path.localeCompare(b.path));
  return { phase: "ready", files };
}

export async function collectReviewFile(root: string, path: string): Promise<ReviewFile | undefined> {
  const entries = await statusEntries(root);
  const entry = entries?.find((candidate) => candidate.path === path);
  return entry ? await reviewFile(root, entry) : undefined;
}

function parseNumstat(output: Buffer): Map<string, ChangeCounts> {
  const fields = output.toString("utf8").split("\0");
  const stats = new Map<string, ChangeCounts>();
  for (let index = 0; index < fields.length;) {
    const field = fields[index++];
    if (!field) continue;
    const [additionsValue, deletionsValue, pathValue] = field.split("\t");
    let path = pathValue;
    if (!path) {
      index += 1;
      path = fields[index++]!;
    }
    stats.set(path, {
      additions: additionsValue === "-" ? 0 : Number(additionsValue),
      deletions: deletionsValue === "-" ? 0 : Number(deletionsValue),
    });
  }
  return stats;
}

function textFileLineCount(content: Buffer | undefined): number {
  if (!content?.byteLength || decodeText(content) === undefined) return 0;
  let lines = 0;
  for (const byte of content) if (byte === 10) lines += 1;
  return lines + (content.at(-1) === 10 ? 0 : 1);
}

export async function collectReviewStats(root: string, index: ReviewIndex): Promise<ReviewFileStats[]> {
  if (index.phase !== "ready") return [];
  let tracked = new Map<string, ChangeCounts>();
  if (index.files.some((file) => !file.untracked)) {
    const head = await git(root, ["rev-parse", "--verify", "HEAD"], true);
    const base = head.byteLength ? "HEAD" : (await git(root, ["hash-object", "-t", "tree", "/dev/null"])).toString("utf8").trim();
    tracked = parseNumstat(await git(root, ["diff", "--numstat", "-z", base, "--"]));
  }
  return Promise.all(index.files.map(async (file) => {
    if (file.untracked) return { ...file, additions: textFileLineCount(await workingFile(root, file.path)), deletions: 0 };
    return { ...file, ...(tracked.get(file.path) ?? { additions: 0, deletions: 0 }) };
  }));
}

export function reviewSnippet(file: ReviewFile, side: ReviewSide, startLine: number, endLine: number): string {
  const text = side === "additions" ? file.newContents : file.oldContents;
  if (text === undefined) return "";
  return text.split("\n").slice(startLine - 1, endLine).join("\n");
}
