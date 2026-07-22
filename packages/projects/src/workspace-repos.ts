import { AtelierCoreError, shellQuote, type AtelierEventBus } from "@atelier/core";
import { execWorkspaceShell, workspaceRoot } from "@atelier/workspace";
import { registerGitIdentityWorkspaceEvents } from "./git-identity.ts";
import { registerProjectWorkspaceInitEvents } from "./workspace-source.ts";

export interface WorkspaceDeleteSafetyIssue { repo: string; uncommittedPaths: string[]; outgoingCommits: Array<{ hash: string; subject: string }> }
export interface WorkspaceDeleteBlockedDetails { workspaceId: string; issues: WorkspaceDeleteSafetyIssue[] }
const workspaceRepoName = "work";

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

async function inspectWorkspaceDeleteSafety(id: string): Promise<WorkspaceDeleteSafetyIssue[]> {
  const quotedPath = shellQuote(workspaceRoot);
  const repo = await execWorkspaceShell(id, `git -C ${quotedPath} rev-parse --is-inside-work-tree >/dev/null 2>&1`);
  if (repo.exitCode !== 0) return [];

  const status = await execWorkspaceShell(id, `git -C ${quotedPath} status --porcelain=v1 -z`);
  if (status.exitCode !== 0) throw new AtelierCoreError("git_error", status.stderr.trim() || `could not check status for ${workspaceRepoName}`);
  await execWorkspaceShell(id, `git -C ${quotedPath} fetch --quiet`);
  const head = await execWorkspaceShell(id, `git -C ${quotedPath} rev-parse --verify HEAD`);
  const upstream = head.exitCode === 0 ? await execWorkspaceShell(id, `git -C ${quotedPath} rev-parse --verify '@{upstream}'`) : { exitCode: 1, stdout: "", stderr: "", durationMs: 0 };
  const commits = head.exitCode !== 0 ? { exitCode: 0, stdout: "", stderr: "", durationMs: 0 } : upstream.exitCode === 0 ? await execWorkspaceShell(id, `git -C ${quotedPath} log --format='%H%x1f%s%x1e' '@{upstream}..HEAD'`) : await execWorkspaceShell(id, `git -C ${quotedPath} log --format='%H%x1f%s%x1e' HEAD --not --remotes`);
  if (commits.exitCode !== 0) throw new AtelierCoreError("git_error", commits.stderr.trim() || `could not check outgoing commits for ${workspaceRepoName}`);
  const issue = { repo: workspaceRepoName, uncommittedPaths: parsePorcelainPaths(status.stdout), outgoingCommits: parseOutgoingCommits(commits.stdout) };
  return issue.uncommittedPaths.length || issue.outgoingCommits.length ? [issue] : [];
}

export function registerProjectWorkspaceEvents(events: AtelierEventBus): void {
  registerProjectWorkspaceInitEvents(events);
  registerGitIdentityWorkspaceEvents(events);
  events.on("workspace_delete_inspect", async ({ workspaceId, issues }) => { issues.push(...(await inspectWorkspaceDeleteSafety(workspaceId))); });
}
