import { join } from "node:path";
import { AtelierCoreError, invalidArguments, shellQuote, type AtelierEventBus } from "@atelier/core";
import { execWorkspaceShell, resolveWorkspace, workspaceManifestPath, workspaceRoot, workspaceWorkHostPath } from "@atelier/workspace";
import { registerGitIdentityWorkspaceEvents } from "./git-identity.ts";
import { registerProjectWorkspaceInitEvents } from "./workspace-source.ts";

export interface WorkspaceRepoListResult { repos: string[] }
export interface WorkspaceRepoSlopometer { netImplementationLines: number; netTestLines: number }
export interface WorkspaceDeleteSafetyIssue { repo: string; uncommittedPaths: string[]; outgoingCommits: Array<{ hash: string; subject: string }> }
export interface WorkspaceDeleteBlockedDetails { workspaceId: string; issues: WorkspaceDeleteSafetyIssue[] }
const singleWorkspaceRepoName = "work";
function validateRepoName(repo: string): void { if (repo === "" || repo.includes("/") || repo === "." || repo === "..") throw invalidArguments(`invalid repo name: ${repo}`); }
function repoPath(repo: string): string { validateRepoName(repo); if (repo !== singleWorkspaceRepoName) throw new AtelierCoreError("repo_not_found", `repo not found: ${repo}`); return workspaceRoot; }

function parsePorcelainPaths(output: string): string[] {
  const paths: string[] = [];
  const records = output.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    paths.push(record.slice(3));
    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") index += 1;
  }
  return paths;
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
export function registerProjectWorkspaceEvents(events: AtelierEventBus): void {
  registerProjectWorkspaceInitEvents(events);
  registerGitIdentityWorkspaceEvents(events);
  events.on("workspace_delete_inspect", async ({ workspaceId, issues }) => { issues.push(...(await inspectWorkspaceDeleteSafety(workspaceId)).issues); });
}

const defaultTestDirectoryPattern = /(^|\/)(__tests__|tests?|specs?)(\/|$)/i;
const defaultTestFilePattern = /(^|[._-])(test|spec)([._-]|$)/i;

async function readWorkspaceSlopometerTestPathPatterns(id: string): Promise<RegExp[]> {
  const path = join(workspaceWorkHostPath(id), workspaceManifestPath);
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    throw invalidArguments(`invalid ${workspaceManifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidArguments(`invalid ${workspaceManifestPath}: expected object`);
  const slopometer = (parsed as Record<string, unknown>).slopometer;
  if (slopometer === undefined) return [];
  if (!slopometer || typeof slopometer !== "object" || Array.isArray(slopometer)) throw invalidArguments(`invalid ${workspaceManifestPath}: slopometer must be an object`);
  const testPathPatterns = (slopometer as Record<string, unknown>).testPathPatterns;
  if (testPathPatterns === undefined) return [];
  if (!Array.isArray(testPathPatterns) || !testPathPatterns.every((pattern) => typeof pattern === "string")) throw invalidArguments(`invalid ${workspaceManifestPath}: slopometer.testPathPatterns must be an array of strings`);
  return testPathPatterns.map((pattern) => {
    try {
      return new RegExp(pattern, "i");
    } catch (error) {
      throw invalidArguments(`invalid ${workspaceManifestPath}: slopometer.testPathPatterns contains invalid regular expression ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
function isTestPath(path: string, userTestPathPatterns: RegExp[]): boolean {
  const normalized = path.replaceAll("\\", "/");
  const fileName = normalized.split("/").at(-1) ?? normalized;
  return defaultTestDirectoryPattern.test(normalized) || defaultTestFilePattern.test(fileName) || userTestPathPatterns.some((pattern) => pattern.test(normalized));
}
function parseSlopometerNumstat(output: string, userTestPathPatterns: RegExp[]): WorkspaceRepoSlopometer {
  let netImplementationLines = 0;
  let netTestLines = 0;
  for (const line of output.split("\n")) {
    const [addText, removeText, path = ""] = line.split("\t", 3);
    const add = Number(addText);
    const remove = Number(removeText);
    const net = (Number.isFinite(add) ? add : 0) - (Number.isFinite(remove) ? remove : 0);
    if (isTestPath(path, userTestPathPatterns)) netTestLines += net;
    else netImplementationLines += net;
  }
  return { netImplementationLines, netTestLines };
}
async function calculateSlopometer(id: string, repo: string): Promise<WorkspaceRepoSlopometer> {
  await ensureRepo(id, repo);
  const userTestPathPatterns = await readWorkspaceSlopometerTestPathPatterns(id);
  const path = repoPath(repo); const quotedPath = shellQuote(path);
  const result = await execWorkspaceShell(id, `set -eu; cd ${quotedPath}; git diff --numstat HEAD -- .; git ls-files --others --exclude-standard -z | xargs -0 -r awk 'FNR==1{files[FILENAME]=1} {lines[FILENAME]++} END{for (file in files) printf "%d\\t0\\t%s\\n", lines[file]+0, file}'`);
  if (result.exitCode !== 0) throw new AtelierCoreError("git_error", result.stderr.trim() || `could not calculate slopometer for ${repo}`);
  return parseSlopometerNumstat(result.stdout, userTestPathPatterns);
}
export async function listWorkspaceRepos(id: string): Promise<WorkspaceRepoListResult> { await resolveWorkspace(id); return { repos: await listRepos(id) }; }
export async function getWorkspaceRepoSlopometer(id: string, repo: string): Promise<WorkspaceRepoSlopometer> { await resolveWorkspace(id); return await calculateSlopometer(id, repo); }
