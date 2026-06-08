import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { requireDocker, runDocker } from "./docker.ts";
import { AtelierCoreError, invalidArguments } from "./errors.ts";
import { listManagedRepos, managedReposDir } from "./managed-repo.ts";

const workspaceTypeLabel = "com.atelier.type";
const namespaceLabel = "com.atelier.namespace";
const titlePath = "/.atelier/title";
const workspaceRoot = "/repos";
const terminalRoot = "/repos";
const atelierReposRoot = "/atelier/repos";
const defaultWorkspaceImage = "ghcr.io/lucasmeijer/atelier-workspace:latest";

export interface WorkspaceNewResult {
  id: string;
}

export interface WorkspaceListResult {
  workspaces: Array<{
    id: string;
    title: string | null;
  }>;
}

export interface WorkspaceExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface WorkspaceRepoListResult {
  repos: string[];
}

export interface WorkspaceTerminalListResult {
  terminals: Array<{ title: string }>;
}

export interface WorkspaceTerminalCreateResult {
  title: string;
}

export interface WorkspaceDeleteSafetyIssue {
  repo: string;
  uncommittedPaths: string[];
  outgoingCommits: Array<{ hash: string; subject: string }>;
}

export interface WorkspaceDeleteBlockedDetails {
  workspaceId: string;
  issues: WorkspaceDeleteSafetyIssue[];
}

export interface DeleteWorkspaceOptions {
  force?: boolean;
}

export interface WorkspaceCloneResult {
  repo: string;
  path: string;
  remoteUrl: string;
  referencePath: string;
}

export interface WorkspaceRepoWorkingTreeStatus {
  stagedFiles: string[];
  addedFiles: string[];
  modifiedFiles: string[];
  removedFiles: string[];
  untrackedFiles: string[];
}

export type WorkspaceRepoMergeabilityResult =
  | { state: "can_push"; ahead: number; behind: number; workingTree: WorkspaceRepoWorkingTreeStatus }
  | { state: "has_conflicts"; ahead: number; behind: number; conflictCount: number; workingTree: WorkspaceRepoWorkingTreeStatus }
  | { state: "fetch_failed"; message: string; workingTree: WorkspaceRepoWorkingTreeStatus }
  | { state: "nothing_to_push"; behind: number; workingTree: WorkspaceRepoWorkingTreeStatus };

export type WorkspaceRepoPushResult =
  | { state: "pushed" }
  | { state: "skipped"; reason: "nothing_to_push" | "has_conflicts" | "fetch_failed" }
  | { state: "failed"; message: string };

function namespace(): string {
  return process.env.ATELIER_NAMESPACE || "default";
}

function workspaceImage(): string {
  return process.env.ATELIER_WORKSPACE_IMAGE || defaultWorkspaceImage;
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw invalidArguments(`missing ${name}`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function repoPath(repo: string): string {
  return `${workspaceRoot}/${repo}`;
}

function bareRepoName(repo: string): string {
  return repo.endsWith(".git") ? repo : `${repo}.git`;
}

function worktreeRepoName(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

function validateRepoName(repo: string): void {
  if (repo === "" || repo.includes("/") || repo === "." || repo === "..") {
    throw invalidArguments(`invalid repo name: ${repo}`);
  }
}

async function execAsAtelier(id: string, command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await runDocker(["exec", "--user", "atelier", id, ...command]);
}

async function execShellAsAtelier(id: string, script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await execAsAtelier(id, ["sh", "-lc", script]);
}

async function inspectLabels(id: string): Promise<Record<string, string>> {
  const inspected = await runDocker(["inspect", "--format", "{{json .Config.Labels}}", id]);
  if (inspected.exitCode !== 0) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);

  const trimmed = inspected.stdout.trim();
  return trimmed && trimmed !== "null" ? JSON.parse(trimmed) as Record<string, string> : {};
}

async function ensureWorkspaceFilesystem(id: string): Promise<void> {
  const result = await runDocker(["exec", "--user", "root", id, "sh", "-lc", `
    set -e
    if [ ! -e ${shellQuote(workspaceRoot)} ] && [ -d /workspace/repos ]; then
      mv /workspace/repos ${shellQuote(workspaceRoot)}
    fi
    mkdir -p ${shellQuote(workspaceRoot)} /.atelier
    chown -R atelier:atelier ${shellQuote(workspaceRoot)} /.atelier
  `]);
  if (result.exitCode !== 0) throw new AtelierCoreError("workspace_repair_failed", result.stderr.trim() || result.stdout.trim() || `could not prepare workspace filesystem for ${id}`);
}

async function resolveWorkspace(id: string): Promise<string> {
  const labels = await inspectLabels(id);
  if (labels[workspaceTypeLabel] !== "workspace" || labels[namespaceLabel] !== namespace()) {
    throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
  }
  await ensureWorkspaceFilesystem(id);
  return id;
}

async function readTitle(id: string): Promise<string | null> {
  const result = await runDocker(["exec", id, "cat", titlePath]);
  if (result.exitCode !== 0) return null;
  return result.stdout.replace(/\n$/, "");
}

export async function createWorkspace(): Promise<WorkspaceNewResult> {
  const reposDir = managedReposDir();
  try {
    await mkdir(reposDir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AtelierCoreError("data_dir_unavailable", `could not create Atelier repos directory ${reposDir}: ${message}`);
  }

  const created = await requireDocker([
    "run",
    "-d",
    "--label",
    `${workspaceTypeLabel}=workspace`,
    "--label",
    `${namespaceLabel}=${namespace()}`,
    "--mount",
    `type=bind,src=${reposDir},dst=${atelierReposRoot}`,
    "--user",
    "root",
    workspaceImage(),
    "sh",
    "-lc",
    "mkdir -p /.atelier /repos; chown -R atelier:atelier /.atelier /repos; sleep infinity",
  ]);

  const fullId = created.stdout.trim();
  const id = fullId.slice(0, 8);
  await requireDocker(["rename", fullId, `atelier-${id}`]);
  await requireDocker(["exec", "--user", "atelier", id, "git", "config", "--global", "user.name", "Lucas Meijer"]);
  await requireDocker(["exec", "--user", "atelier", id, "git", "config", "--global", "user.email", "lucas@lucasmeijer.com"]);
  await createWorkspaceTerminal(id);

  return { id };
}

export async function listWorkspaces(): Promise<WorkspaceListResult> {

  const listed = await requireDocker([
    "ps",
    "-aq",
    "--filter",
    `label=${workspaceTypeLabel}=workspace`,
    "--filter",
    `label=${namespaceLabel}=${namespace()}`,
  ]);

  const ids = listed.stdout.trim().split(/\s+/).filter(Boolean).map((id) => id.slice(0, 8));
  const workspaces: WorkspaceListResult["workspaces"] = [];
  for (const id of ids) {
    workspaces.push({ id, title: await readTitle(id) });
  }

  return { workspaces };
}

function parsePorcelainPaths(output: string): string[] {
  const paths: string[] = [];
  for (const entry of parsePorcelainEntries(output)) paths.push(entry.path);
  return paths;
}

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

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function parseWorkingTreeStatus(output: string): WorkspaceRepoWorkingTreeStatus {
  const stagedFiles: string[] = [];
  const addedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const removedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  for (const entry of parsePorcelainEntries(output)) {
    if (entry.indexStatus === "?" && entry.worktreeStatus === "?") {
      untrackedFiles.push(entry.path);
      continue;
    }
    if (entry.indexStatus !== " " && entry.indexStatus !== "?") stagedFiles.push(entry.path);
    if (entry.indexStatus === "A") addedFiles.push(entry.path);
    if (entry.indexStatus === "M" || entry.worktreeStatus === "M") modifiedFiles.push(entry.path);
    if (entry.indexStatus === "D" || entry.worktreeStatus === "D") removedFiles.push(entry.path);
  }

  return {
    stagedFiles: uniqueSorted(stagedFiles),
    addedFiles: uniqueSorted(addedFiles),
    modifiedFiles: uniqueSorted(modifiedFiles),
    removedFiles: uniqueSorted(removedFiles),
    untrackedFiles: uniqueSorted(untrackedFiles),
  };
}

function parseOutgoingCommits(output: string): Array<{ hash: string; subject: string }> {
  return output.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const separatorIndex = record.indexOf("\x1f");
    if (separatorIndex === -1) return { hash: record, subject: "" };
    return { hash: record.slice(0, separatorIndex), subject: record.slice(separatorIndex + 1) };
  });
}

function formatDeleteBlockedMessage(id: string, issues: WorkspaceDeleteSafetyIssue[]): string {
  const lines = [`workspace ${id} has uncommitted changes or unpushed commits:`];
  for (const issue of issues) {
    lines.push(`- ${issue.repo}`);
    if (issue.uncommittedPaths.length > 0) {
      lines.push("  uncommitted/staged paths:");
      for (const path of issue.uncommittedPaths) lines.push(`    - ${path}`);
    }
    if (issue.outgoingCommits.length > 0) {
      lines.push("  unpushed commits:");
      for (const commit of issue.outgoingCommits) lines.push(`    - ${commit.hash.slice(0, 12)} ${commit.subject}`.trimEnd());
    }
  }
  lines.push("use --force to delete anyway");
  return lines.join("\n");
}

export async function inspectWorkspaceDeleteSafety(id: string): Promise<WorkspaceDeleteBlockedDetails> {
  await resolveWorkspace(id);
  const repos = await listRepos(id);
  const issues: WorkspaceDeleteSafetyIssue[] = [];

  for (const repo of repos) {
    const path = repoPath(repo);
    const quotedPath = shellQuote(path);
    const status = await execShellAsAtelier(id, `git -C ${quotedPath} status --porcelain=v1 -z`);
    if (status.exitCode !== 0) throw new AtelierCoreError("git_error", status.stderr.trim() || `could not check status for ${repo}`);

    await execShellAsAtelier(id, `git -C ${quotedPath} fetch --quiet`);
    const head = await execShellAsAtelier(id, `git -C ${quotedPath} rev-parse --verify HEAD`);
    const upstream = head.exitCode === 0 ? await execShellAsAtelier(id, `git -C ${quotedPath} rev-parse --verify '@{upstream}'`) : { exitCode: 1, stdout: "", stderr: "" };
    const commits = head.exitCode !== 0
      ? { exitCode: 0, stdout: "", stderr: "" }
      : upstream.exitCode === 0
        ? await execShellAsAtelier(id, `git -C ${quotedPath} log --format='%H%x1f%s%x1e' '@{upstream}..HEAD'`)
        : await execShellAsAtelier(id, `git -C ${quotedPath} log --format='%H%x1f%s%x1e' HEAD --not --remotes`);
    if (commits.exitCode !== 0) throw new AtelierCoreError("git_error", commits.stderr.trim() || `could not check outgoing commits for ${repo}`);

    const issue: WorkspaceDeleteSafetyIssue = {
      repo,
      uncommittedPaths: parsePorcelainPaths(status.stdout),
      outgoingCommits: parseOutgoingCommits(commits.stdout),
    };
    if (issue.uncommittedPaths.length > 0 || issue.outgoingCommits.length > 0) issues.push(issue);
  }

  return { workspaceId: id, issues };
}

export async function deleteWorkspace(id: string, options: DeleteWorkspaceOptions = {}): Promise<null> {
  await resolveWorkspace(id);
  if (!options.force) {
    const details = await inspectWorkspaceDeleteSafety(id);
    if (details.issues.length > 0) {
      throw new AtelierCoreError("workspace_delete_blocked", formatDeleteBlockedMessage(id, details.issues), details);
    }
  }
  await requireDocker(["rm", "-f", id]);
  return null;
}

export async function setWorkspaceTitle(id: string, title: string): Promise<null> {
  await resolveWorkspace(id);

  await requireDocker(["exec", "-i", id, "sh", "-c", `mkdir -p /.atelier && cat > ${titlePath}`], { stdin: title });
  return null;
}

export async function execWorkspace(id: string, command: string[]): Promise<WorkspaceExecResult> {
  if (command.length === 0) throw invalidArguments("workspace exec requires a command");

  await resolveWorkspace(id);

  const started = performance.now();
  const result = await execAsAtelier(id, command);
  const durationMs = Math.round(performance.now() - started);

  const execResult: WorkspaceExecResult = {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs,
  };
  return execResult;
}

async function ensureRepo(id: string, repo: string): Promise<void> {
  validateRepoName(repo);
  const path = repoPath(repo);
  const result = await execShellAsAtelier(id, `test -d ${shellQuote(path)} && git -C ${shellQuote(path)} rev-parse --is-inside-work-tree >/dev/null 2>&1`);
  if (result.exitCode !== 0) throw new AtelierCoreError("repo_not_found", `repo not found: ${repo}`);
}

async function listRepos(id: string): Promise<string[]> {
  const script = `mkdir -p ${shellQuote(workspaceRoot)} && find ${shellQuote(workspaceRoot)} -mindepth 1 -maxdepth 1 -type d ! -name '.*' -exec sh -c 'for dir do git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 && basename "$dir"; done' sh {} + | sort`;
  const result = await execShellAsAtelier(id, script);
  if (result.exitCode !== 0) throw new AtelierCoreError("git_error", result.stderr.trim() || "could not list repos");
  return result.stdout.trim().split(/\n+/).filter(Boolean);
}

export async function cloneManagedRepoIntoWorkspace(id: string, repo: string): Promise<WorkspaceCloneResult> {
  validateRepoName(repo);
  await resolveWorkspace(id);

  const bareName = bareRepoName(repo);
  const worktreeName = worktreeRepoName(repo);
  const managed = (await listManagedRepos()).repos.find((candidate) => candidate.name === bareName || candidate.name === repo);
  if (!managed) throw new AtelierCoreError("managed_repo_not_found", `managed repo not found: ${repo}`);
  const targetPath = repoPath(worktreeName);
  const referencePath = join(atelierReposRoot, managed.name);
  const result = await execShellAsAtelier(
    id,
    `set -e
      mkdir -p ${shellQuote(workspaceRoot)}
      if [ -e ${shellQuote(targetPath)} ]; then
        printf 'repo already exists: %s\n' ${shellQuote(worktreeName)} >&2
        exit 17
      fi
      git clone --reference ${shellQuote(referencePath)} ${shellQuote(referencePath)} ${shellQuote(targetPath)}
    `,
  );
  if (result.exitCode !== 0) {
    const message = (result.stderr || result.stdout).trim();
    if (message.includes("File exists")) throw new AtelierCoreError("repo_already_exists", `repo already exists: ${worktreeName}`);
    throw new AtelierCoreError("git_clone_failed", message || `could not clone ${repo}`);
  }

  return { repo: worktreeName, path: targetPath, remoteUrl: referencePath, referencePath };
}

async function calculateMergeability(id: string, repo: string): Promise<WorkspaceRepoMergeabilityResult> {
  await ensureRepo(id, repo);
  const path = repoPath(repo);
  const quotedPath = shellQuote(path);

  const status = await execShellAsAtelier(id, `git -C ${quotedPath} status --porcelain=v1 -z`);
  if (status.exitCode !== 0) throw new AtelierCoreError("git_error", status.stderr.trim() || `could not check status for ${repo}`);
  const workingTree = parseWorkingTreeStatus(status.stdout);

  const fetched = await execShellAsAtelier(id, `git -C ${quotedPath} fetch`);
  if (fetched.exitCode !== 0) {
    return { state: "fetch_failed", message: (fetched.stderr || fetched.stdout).trim(), workingTree };
  }

  const upstream = await execShellAsAtelier(id, `git -C ${quotedPath} rev-parse --verify '@{upstream}'`);
  if (upstream.exitCode !== 0) throw new AtelierCoreError("git_error", upstream.stderr.trim() || `could not resolve upstream for ${repo}`);

  const counts = await execShellAsAtelier(id, `git -C ${quotedPath} rev-list --left-right --count '@{upstream}'...HEAD`);
  if (counts.exitCode !== 0) throw new AtelierCoreError("git_error", counts.stderr.trim() || `could not calculate ahead/behind for ${repo}`);

  const [behindText, aheadText] = counts.stdout.trim().split(/\s+/);
  const behind = Number(behindText);
  const ahead = Number(aheadText);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    throw new AtelierCoreError("git_error", `could not parse ahead/behind for ${repo}`);
  }

  if (ahead === 0) return { state: "nothing_to_push", behind, workingTree };
  if (behind === 0) return { state: "can_push", ahead, behind, workingTree };

  const mergeCheck = await execShellAsAtelier(id, `
    set -u
    cd ${quotedPath}
    mkdir -p /.atelier/tmp
    tmp_index="$(mktemp /.atelier/tmp/merge-index.XXXXXX)"
    rm -f "$tmp_index"
    trap 'rm -f "$tmp_index"' EXIT
    upstream="$(git rev-parse --verify '@{upstream}')"
    base="$(git merge-base "$upstream" HEAD)"
    GIT_INDEX_FILE="$tmp_index" git read-tree -m "$base" "$upstream" HEAD 2>/dev/null || true
    conflicts="$(GIT_INDEX_FILE="$tmp_index" git ls-files -u 2>/dev/null | cut -f2 | sort -u | wc -l | tr -d ' ')"
    if [ "$conflicts" = "0" ]; then
      printf 'clean\\n'
    else
      printf 'conflicts %s\\n' "$conflicts"
    fi
  `);
  if (mergeCheck.exitCode !== 0) throw new AtelierCoreError("git_error", mergeCheck.stderr.trim() || `could not calculate mergeability for ${repo}`);

  const output = mergeCheck.stdout.trim();
  if (output === "clean") return { state: "can_push", ahead, behind, workingTree }; 

  const match = output.match(/^conflicts\s+(\d+)$/);
  if (match) return { state: "has_conflicts", ahead, behind, conflictCount: Number(match[1]), workingTree };

  throw new AtelierCoreError("git_error", `could not parse mergeability for ${repo}`);
}

export async function listWorkspaceRepos(id: string): Promise<WorkspaceRepoListResult> {
  await resolveWorkspace(id);
  return { repos: await listRepos(id) };
}

export async function getWorkspaceRepoMergeability(id: string, repo: string): Promise<WorkspaceRepoMergeabilityResult> {
  await resolveWorkspace(id);
  return await calculateMergeability(id, repo);
}

export async function listWorkspaceTerminals(id: string): Promise<WorkspaceTerminalListResult> {
  await resolveWorkspace(id);

  const result = await execShellAsAtelier(id, "tmux list-sessions -F '#S'");
  if (result.exitCode !== 0) return { terminals: [] };
  return { terminals: result.stdout.trim().split(/\n+/).filter(Boolean).map((title) => ({ title })) };
}

export async function createWorkspaceTerminal(id: string): Promise<WorkspaceTerminalCreateResult> {
  const { terminals } = await listWorkspaceTerminals(id);
  const used = new Set<number>();
  for (const { title } of terminals) {
    const match = title.match(/^Terminal (\d+)$/);
    if (match) used.add(Number(match[1]));
  }

  let index = 1;
  while (used.has(index)) index += 1;
  const title = `Terminal ${index}`;

  const result = await execShellAsAtelier(
    id,
    `TERM=xterm-ghostty COLORTERM=truecolor tmux new-session -d -s ${shellQuote(title)} -c ${shellQuote(terminalRoot)} /bin/bash`,
  );
  if (result.exitCode !== 0) throw new AtelierCoreError("terminal_create_failed", result.stderr.trim() || `could not create terminal: ${title}`);

  return { title };
}

export async function deleteWorkspaceTerminal(id: string, title: string): Promise<null> {
  const { terminals } = await listWorkspaceTerminals(id);
  if (!terminals.some((terminal) => terminal.title === title)) {
    throw new AtelierCoreError("terminal_not_found", `terminal not found: ${title}`);
  }

  const result = await execShellAsAtelier(id, `tmux kill-session -t ${shellQuote(title)}`);
  if (result.exitCode !== 0) throw new AtelierCoreError("terminal_delete_failed", result.stderr.trim() || `could not delete terminal: ${title}`);
  return null;
}

export async function pushWorkspaceRepo(id: string, repo: string): Promise<WorkspaceRepoPushResult> {
  await resolveWorkspace(id);

  const mergeability = await calculateMergeability(id, repo);
  let skipped: WorkspaceRepoPushResult | undefined;
  switch (mergeability.state) {
    case "nothing_to_push":
      skipped = { state: "skipped", reason: "nothing_to_push" };
      break;
    case "has_conflicts":
      skipped = { state: "skipped", reason: "has_conflicts" };
      break;
    case "fetch_failed":
      skipped = { state: "skipped", reason: "fetch_failed" };
      break;
  }
  if (skipped) return skipped;

  const path = repoPath(repo);
  const rebased = await execShellAsAtelier(id, `git -C ${shellQuote(path)} rebase '@{upstream}'`);
  if (rebased.exitCode !== 0) {
    return { state: "failed", message: (rebased.stderr || rebased.stdout).trim() };
  }

  const pushed = await execShellAsAtelier(id, `git -C ${shellQuote(path)} push`);
  if (pushed.exitCode !== 0) {
    return { state: "failed", message: (pushed.stderr || pushed.stdout).trim() };
  }

  return { state: "pushed" };
}

async function workspaceRepoCommand(args: string[]): Promise<unknown> {
  const id = requireArg(args[0], "workspace id");
  if (args[1] !== "repo") throw invalidArguments("usage: atelier workspace <workspace-id> repo <command>");

  const [command, ...rest] = args.slice(2);
  switch (command) {
    case "list":
      if (rest.length !== 0) throw invalidArguments("workspace repo list takes no arguments");
      return await listWorkspaceRepos(id);
    case "mergeability": {
      const repo = requireArg(rest[0], "repo name");
      if (rest.length !== 1) throw invalidArguments("usage: atelier workspace <workspace-id> repo mergeability <repo>");
      return await getWorkspaceRepoMergeability(id, repo);
    }
    case "push": {
      const repo = requireArg(rest[0], "repo name");
      if (rest.length !== 1) throw invalidArguments("usage: atelier workspace <workspace-id> repo push <repo>");
      return await pushWorkspaceRepo(id, repo);
    }
    default:
      throw invalidArguments(`unknown repo command: ${command ?? ""}`);
  }
}

export async function workspaceCommand(args: string[]): Promise<unknown> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "new":
      if (rest.length !== 0) throw invalidArguments("workspace new takes no arguments");
      return await createWorkspace();
    case "list":
      if (rest.length !== 0) throw invalidArguments("workspace list takes no arguments");
      return await listWorkspaces();
    case "delete": {
      const force = rest.includes("--force");
      const ids = rest.filter((arg) => arg !== "--force");
      const id = requireArg(ids[0], "workspace id");
      if (ids.length !== 1) throw invalidArguments("usage: atelier workspace delete [--force] <workspace-id>");
      return await deleteWorkspace(id, { force });
    }
    case "title": {
      const id = requireArg(rest[0], "workspace id");
      return await setWorkspaceTitle(id, rest.slice(1).join(" "));
    }
    case "exec": {
      const id = requireArg(rest[0], "workspace id");
      const separatorIndex = rest.indexOf("--");
      if (separatorIndex !== 1) throw invalidArguments("usage: atelier workspace exec <workspace-id> -- <command...>");
      return await execWorkspace(id, rest.slice(separatorIndex + 1));
    }
    default:
      if (args[1] === "clone") {
        const id = requireArg(args[0], "workspace id");
        const repo = requireArg(args[2], "repo name");
        if (args.length !== 3) throw invalidArguments("usage: atelier workspace <workspace-id> clone <repo>");
        return await cloneManagedRepoIntoWorkspace(id, repo);
      }
      return await workspaceRepoCommand(args);
  }
}
