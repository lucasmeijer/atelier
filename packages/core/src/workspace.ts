import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { requireDocker, runDocker } from "./docker.ts";
import { AtelierCoreError, invalidArguments } from "./errors.ts";
import { listManagedRepos, managedReposDir } from "./managed-repo.ts";

const workspaceTypeLabel = "com.atelier.type";
const namespaceLabel = "com.atelier.namespace";
const titlePath = "/.atelier/title";
const workspaceRoot = "/workspace/repos";
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


export interface WorkspaceCloneResult {
  repo: string;
  path: string;
  remoteUrl: string;
  referencePath: string;
}

export type WorkspaceRepoMergeabilityResult =
  | { state: "can_push"; ahead: number; behind: number }
  | { state: "has_conflicts"; ahead: number; behind: number; conflictCount: number }
  | { state: "fetch_failed"; message: string }
  | { state: "nothing_to_push"; behind: number };

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

async function resolveWorkspace(id: string): Promise<string> {
  const labels = await inspectLabels(id);
  if (labels[workspaceTypeLabel] !== "workspace" || labels[namespaceLabel] !== namespace()) {
    throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
  }
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
    "mkdir -p /.atelier /workspace/repos; chown -R atelier:atelier /.atelier /workspace; sleep infinity",
  ]);

  const fullId = created.stdout.trim();
  const id = fullId.slice(0, 8);
  await requireDocker(["rename", fullId, `atelier-${id}`]);

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

export async function deleteWorkspace(id: string): Promise<null> {
  await resolveWorkspace(id);
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

  const fetched = await execShellAsAtelier(id, `git -C ${quotedPath} fetch`);
  if (fetched.exitCode !== 0) {
    return { state: "fetch_failed", message: (fetched.stderr || fetched.stdout).trim() };
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

  if (ahead === 0) return { state: "nothing_to_push", behind };

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
  if (output === "clean") return { state: "can_push", ahead, behind };

  const match = output.match(/^conflicts\s+(\d+)$/);
  if (match) return { state: "has_conflicts", ahead, behind, conflictCount: Number(match[1]) };

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
      const id = requireArg(rest[0], "workspace id");
      if (rest.length !== 1) throw invalidArguments("usage: atelier workspace delete <workspace-id>");
      return await deleteWorkspace(id);
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
