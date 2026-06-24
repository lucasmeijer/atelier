import { AtelierCoreError, invalidArguments, shellQuote, type AtelierEventBus } from "@atelier/core";
import { execWorkspaceShell, resolveWorkspace, workspaceRoot } from "@atelier/workspace";
import { registerGitIdentityWorkspaceEvents } from "./git-identity.ts";
import { registerRepositoryWorkspaceSourceEvents } from "./workspace-source.ts";

export interface WorkspaceRepoListResult { repos: string[] }
export interface WorkspaceRepoWorkingTreeStatus { stagedFiles: string[]; addedFiles: string[]; modifiedFiles: string[]; removedFiles: string[]; untrackedFiles: string[] }
export interface WorkspaceRepoLineStats { added: number; removed: number }
export interface WorkspaceDeleteSafetyIssue { repo: string; uncommittedPaths: string[]; outgoingCommits: Array<{ hash: string; subject: string }> }
export interface WorkspaceDeleteBlockedDetails { workspaceId: string; issues: WorkspaceDeleteSafetyIssue[] }
export type WorkspaceRepoMergeabilityResult =
  | { state: "can_push"; ahead: number; behind: number; workingTree: WorkspaceRepoWorkingTreeStatus }
  | { state: "has_conflicts"; ahead: number; behind: number; conflictCount: number; workingTree: WorkspaceRepoWorkingTreeStatus }
  | { state: "fetch_failed"; message: string; workingTree: WorkspaceRepoWorkingTreeStatus }
  | { state: "nothing_to_push"; behind: number; workingTree: WorkspaceRepoWorkingTreeStatus };
export type WorkspaceRepoPushResult = { state: "pushed" } | { state: "skipped"; reason: "nothing_to_push" | "has_conflicts" | "fetch_failed" } | { state: "failed"; message: string };

const singleWorkspaceRepoName = "work";
function validateRepoName(repo: string): void { if (repo === "" || repo.includes("/") || repo === "." || repo === "..") throw invalidArguments(`invalid repo name: ${repo}`); }
function repoPath(repo: string): string { validateRepoName(repo); if (repo !== singleWorkspaceRepoName) throw new AtelierCoreError("repo_not_found", `repo not found: ${repo}`); return workspaceRoot; }

function parsePorcelainEntries(output: string): Array<{ indexStatus: string; worktreeStatus: string; path: string }> {
  const entries: Array<{ indexStatus: string; worktreeStatus: string; path: string }> = [];
  const records = output.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    entries.push({ indexStatus, worktreeStatus, path: record.slice(3) });
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") index += 1;
  }
  return entries;
}
function parsePorcelainPaths(output: string): string[] { return parsePorcelainEntries(output).map((entry) => entry.path); }
function uniqueSorted(values: string[]): string[] { return Array.from(new Set(values)).sort(); }
function parseWorkingTreeStatus(output: string): WorkspaceRepoWorkingTreeStatus {
  const stagedFiles: string[] = [], addedFiles: string[] = [], modifiedFiles: string[] = [], removedFiles: string[] = [], untrackedFiles: string[] = [];
  for (const entry of parsePorcelainEntries(output)) {
    if (entry.indexStatus === "?" && entry.worktreeStatus === "?") { untrackedFiles.push(entry.path); continue; }
    if (entry.indexStatus !== " " && entry.indexStatus !== "?") stagedFiles.push(entry.path);
    if (entry.indexStatus === "A") addedFiles.push(entry.path);
    if (entry.indexStatus === "M" || entry.worktreeStatus === "M") modifiedFiles.push(entry.path);
    if (entry.indexStatus === "D" || entry.worktreeStatus === "D") removedFiles.push(entry.path);
  }
  return { stagedFiles: uniqueSorted(stagedFiles), addedFiles: uniqueSorted(addedFiles), modifiedFiles: uniqueSorted(modifiedFiles), removedFiles: uniqueSorted(removedFiles), untrackedFiles: uniqueSorted(untrackedFiles) };
}
function parseOutgoingCommits(output: string): Array<{ hash: string; subject: string }> {
  return output.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const separatorIndex = record.indexOf("\x1f");
    return separatorIndex === -1 ? { hash: record, subject: "" } : { hash: record.slice(0, separatorIndex), subject: record.slice(separatorIndex + 1) };
  });
}
function formatDeleteBlockedMessage(id: string, issues: WorkspaceDeleteSafetyIssue[]): string {
  const lines = [`workspace ${id} has uncommitted changes or unpushed commits:`];
  for (const issue of issues) {
    lines.push(`- ${issue.repo}`);
    if (issue.uncommittedPaths.length) lines.push("  uncommitted/staged paths:", ...issue.uncommittedPaths.map((path) => `    - ${path}`));
    if (issue.outgoingCommits.length) lines.push("  unpushed commits:", ...issue.outgoingCommits.map((commit) => `    - ${commit.hash.slice(0, 12)} ${commit.subject}`.trimEnd()));
  }
  lines.push("use --force to delete anyway");
  return lines.join("\n");
}

async function listRepos(id: string): Promise<string[]> {
  const result = await execWorkspaceShell(id, `mkdir -p ${shellQuote(workspaceRoot)} && git -C ${shellQuote(workspaceRoot)} rev-parse --is-inside-work-tree >/dev/null 2>&1`);
  return result.exitCode === 0 ? [singleWorkspaceRepoName] : [];
}
async function ensureRepo(id: string, repo: string): Promise<void> {
  const path = repoPath(repo);
  const result = await execWorkspaceShell(id, `test -d ${shellQuote(path)} && git -C ${shellQuote(path)} rev-parse --is-inside-work-tree >/dev/null 2>&1`);
  if (result.exitCode !== 0) throw new AtelierCoreError("repo_not_found", `repo not found: ${repo}`);
}

export async function inspectWorkspaceDeleteSafety(id: string): Promise<WorkspaceDeleteBlockedDetails> {
  await resolveWorkspace(id);
  const issues: WorkspaceDeleteSafetyIssue[] = [];
  for (const repo of await listRepos(id)) {
    const path = repoPath(repo); const quotedPath = shellQuote(path);
    const status = await execWorkspaceShell(id, `git -C ${quotedPath} status --porcelain=v1 -z`);
    if (status.exitCode !== 0) throw new AtelierCoreError("git_error", status.stderr.trim() || `could not check status for ${repo}`);
    await execWorkspaceShell(id, `git -C ${quotedPath} fetch --quiet`);
    const head = await execWorkspaceShell(id, `git -C ${quotedPath} rev-parse --verify HEAD`);
    const upstream = head.exitCode === 0 ? await execWorkspaceShell(id, `git -C ${quotedPath} rev-parse --verify '@{upstream}'`) : { exitCode: 1, stdout: "", stderr: "", durationMs: 0 };
    const commits = head.exitCode !== 0 ? { exitCode: 0, stdout: "", stderr: "", durationMs: 0 } : upstream.exitCode === 0 ? await execWorkspaceShell(id, `git -C ${quotedPath} log --format='%H%x1f%s%x1e' '@{upstream}..HEAD'`) : await execWorkspaceShell(id, `git -C ${quotedPath} log --format='%H%x1f%s%x1e' HEAD --not --remotes`);
    if (commits.exitCode !== 0) throw new AtelierCoreError("git_error", commits.stderr.trim() || `could not check outgoing commits for ${repo}`);
    const issue = { repo, uncommittedPaths: parsePorcelainPaths(status.stdout), outgoingCommits: parseOutgoingCommits(commits.stdout) };
    if (issue.uncommittedPaths.length || issue.outgoingCommits.length) issues.push(issue);
  }
  return { workspaceId: id, issues };
}
export async function assertWorkspaceDeleteSafe(id: string): Promise<void> {
  const details = await inspectWorkspaceDeleteSafety(id);
  if (details.issues.length > 0) throw new AtelierCoreError("workspace_delete_blocked", formatDeleteBlockedMessage(id, details.issues), details);
}
export function registerRepositoryWorkspaceEvents(events: AtelierEventBus): void {
  registerRepositoryWorkspaceSourceEvents(events);
  registerGitIdentityWorkspaceEvents(events);
  events.on("workspace_delete_inspect", async ({ workspaceId, issues }) => { issues.push(...(await inspectWorkspaceDeleteSafety(workspaceId)).issues); });
}

async function calculateMergeability(id: string, repo: string): Promise<WorkspaceRepoMergeabilityResult> {
  await ensureRepo(id, repo); const path = repoPath(repo); const quotedPath = shellQuote(path);
  const status = await execWorkspaceShell(id, `git -C ${quotedPath} status --porcelain=v1 -z`);
  if (status.exitCode !== 0) throw new AtelierCoreError("git_error", status.stderr.trim() || `could not check status for ${repo}`);
  const workingTree = parseWorkingTreeStatus(status.stdout);
  const fetched = await execWorkspaceShell(id, `git -C ${quotedPath} fetch`);
  if (fetched.exitCode !== 0) return { state: "fetch_failed", message: (fetched.stderr || fetched.stdout).trim(), workingTree };
  const upstream = await execWorkspaceShell(id, `git -C ${quotedPath} rev-parse --verify '@{upstream}'`);
  if (upstream.exitCode !== 0) throw new AtelierCoreError("git_error", upstream.stderr.trim() || `could not resolve upstream for ${repo}`);
  const counts = await execWorkspaceShell(id, `git -C ${quotedPath} rev-list --left-right --count '@{upstream}'...HEAD`);
  if (counts.exitCode !== 0) throw new AtelierCoreError("git_error", counts.stderr.trim() || `could not calculate ahead/behind for ${repo}`);
  const [behindText, aheadText] = counts.stdout.trim().split(/\s+/); const behind = Number(behindText); const ahead = Number(aheadText);
  if (ahead === 0) return { state: "nothing_to_push", behind, workingTree };
  if (behind === 0) return { state: "can_push", ahead, behind, workingTree };
  const mergeCheck = await execWorkspaceShell(id, `set -u; cd ${quotedPath}; mkdir -p /.atelier/tmp; tmp_index="$(mktemp /.atelier/tmp/merge-index.XXXXXX)"; rm -f "$tmp_index"; trap 'rm -f "$tmp_index"' EXIT; upstream="$(git rev-parse --verify '@{upstream}')"; base="$(git merge-base "$upstream" HEAD)"; GIT_INDEX_FILE="$tmp_index" git read-tree -m "$base" "$upstream" HEAD 2>/dev/null || true; conflicts="$(GIT_INDEX_FILE="$tmp_index" git ls-files -u 2>/dev/null | cut -f2 | sort -u | wc -l | tr -d ' ')"; if [ "$conflicts" = "0" ]; then printf 'clean\\n'; else printf 'conflicts %s\\n' "$conflicts"; fi`);
  if (mergeCheck.exitCode !== 0) throw new AtelierCoreError("git_error", mergeCheck.stderr.trim() || `could not calculate mergeability for ${repo}`);
  if (mergeCheck.stdout.trim() === "clean") return { state: "can_push", ahead, behind, workingTree };
  const match = mergeCheck.stdout.trim().match(/^conflicts\s+(\d+)$/); if (match) return { state: "has_conflicts", ahead, behind, conflictCount: Number(match[1]), workingTree };
  throw new AtelierCoreError("git_error", `could not parse mergeability for ${repo}`);
}
function parseNumstat(output: string): WorkspaceRepoLineStats {
  let added = 0;
  let removed = 0;
  for (const line of output.split("\n")) {
    const [addText, removeText] = line.trim().split(/\s+/, 3);
    const add = Number(addText);
    const remove = Number(removeText);
    if (Number.isFinite(add)) added += add;
    if (Number.isFinite(remove)) removed += remove;
  }
  return { added, removed };
}
async function calculateLineStats(id: string, repo: string): Promise<WorkspaceRepoLineStats> {
  await ensureRepo(id, repo);
  const path = repoPath(repo); const quotedPath = shellQuote(path);
  const result = await execWorkspaceShell(id, `set -eu; cd ${quotedPath}; git diff --numstat HEAD -- .; git ls-files --others --exclude-standard -z | xargs -0 -r awk 'FNR==1{files[FILENAME]=1} {lines[FILENAME]++} END{for (file in files) printf "%d\\t0\\t%s\\n", lines[file]+0, file}'`);
  if (result.exitCode !== 0) throw new AtelierCoreError("git_error", result.stderr.trim() || `could not calculate line stats for ${repo}`);
  return parseNumstat(result.stdout);
}
export async function listWorkspaceRepos(id: string): Promise<WorkspaceRepoListResult> { await resolveWorkspace(id); return { repos: await listRepos(id) }; }
export async function getWorkspaceRepoLineStats(id: string, repo: string): Promise<WorkspaceRepoLineStats> { await resolveWorkspace(id); return await calculateLineStats(id, repo); }
export async function getWorkspaceRepoMergeability(id: string, repo: string): Promise<WorkspaceRepoMergeabilityResult> { await resolveWorkspace(id); return await calculateMergeability(id, repo); }
export async function pushWorkspaceRepo(id: string, repo: string): Promise<WorkspaceRepoPushResult> {
  await resolveWorkspace(id); const mergeability = await calculateMergeability(id, repo);
  if (mergeability.state === "nothing_to_push") return { state: "skipped", reason: "nothing_to_push" };
  if (mergeability.state === "has_conflicts") return { state: "skipped", reason: "has_conflicts" };
  if (mergeability.state === "fetch_failed") return { state: "skipped", reason: "fetch_failed" };
  const path = repoPath(repo);
  const rebased = await execWorkspaceShell(id, `git -C ${shellQuote(path)} rebase '@{upstream}'`); if (rebased.exitCode !== 0) return { state: "failed", message: (rebased.stderr || rebased.stdout).trim() };
  const pushed = await execWorkspaceShell(id, `git -C ${shellQuote(path)} push`); if (pushed.exitCode !== 0) return { state: "failed", message: (pushed.stderr || pushed.stdout).trim() };
  return { state: "pushed" };
}

