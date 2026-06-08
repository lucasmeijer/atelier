import { requireDocker, runDocker } from "./docker.ts";
import { CliError, invalidArguments, writeSuccess } from "./json.ts";

const workspaceTypeLabel = "com.atelier.type";
const namespaceLabel = "com.atelier.namespace";
const titlePath = "/.atelier/title";
const workspaceRoot = "/workspace";

interface WorkspaceListResult {
  workspaces: Array<{
    id: string;
    title: string | null;
  }>;
}

interface WorkspaceExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

type WorkspaceRepoMergeabilityResult =
  | { state: "can_push"; ahead: number; behind: number }
  | { state: "has_conflicts"; ahead: number; behind: number; conflictCount: number }
  | { state: "fetch_failed"; message: string }
  | { state: "nothing_to_push"; behind: number };

type WorkspaceRepoPushResult =
  | { state: "pushed" }
  | { state: "skipped"; reason: "nothing_to_push" | "has_conflicts" | "fetch_failed" }
  | { state: "failed"; message: string };

function namespace(): string {
  return process.env.ATELIER_NAMESPACE || "default";
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
  if (inspected.exitCode !== 0) throw new CliError("workspace_not_found", `workspace not found: ${id}`);

  const trimmed = inspected.stdout.trim();
  return trimmed && trimmed !== "null" ? JSON.parse(trimmed) as Record<string, string> : {};
}

async function resolveWorkspace(id: string): Promise<string> {
  const labels = await inspectLabels(id);
  if (labels[workspaceTypeLabel] !== "workspace" || labels[namespaceLabel] !== namespace()) {
    throw new CliError("workspace_not_found", `workspace not found: ${id}`);
  }
  return id;
}

async function readTitle(id: string): Promise<string | null> {
  const result = await runDocker(["exec", id, "cat", titlePath]);
  if (result.exitCode !== 0) return null;
  return result.stdout.replace(/\n$/, "");
}

async function workspaceNew(args: string[]): Promise<void> {
  if (args.length !== 0) throw invalidArguments("workspace new takes no arguments");

  const created = await requireDocker([
    "run",
    "-d",
    "--label",
    `${workspaceTypeLabel}=workspace`,
    "--label",
    `${namespaceLabel}=${namespace()}`,
    "--user",
    "root",
    "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
    "sh",
    "-lc",
    "id -u atelier >/dev/null 2>&1 || useradd --create-home --shell /bin/bash atelier; mkdir -p /.atelier /workspace; chown -R atelier:atelier /.atelier /workspace; sleep infinity",
  ]);

  const fullId = created.stdout.trim();
  const id = fullId.slice(0, 8);
  await requireDocker(["rename", fullId, `atelier-${id}`]);

  writeSuccess({ id });
}

async function workspaceList(args: string[]): Promise<void> {
  if (args.length !== 0) throw invalidArguments("workspace list takes no arguments");

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

  writeSuccess({ workspaces });
}

async function workspaceDelete(args: string[]): Promise<void> {
  const id = requireArg(args[0], "workspace id");
  if (args.length !== 1) throw invalidArguments("usage: atelier workspace delete <workspace-id>");

  await resolveWorkspace(id);
  await requireDocker(["rm", "-f", id]);
  writeSuccess(null);
}

async function workspaceTitle(args: string[]): Promise<void> {
  const id = requireArg(args[0], "workspace id");
  const title = args.slice(1).join(" ");
  await resolveWorkspace(id);

  await requireDocker(["exec", "-i", id, "sh", "-c", `mkdir -p /.atelier && cat > ${titlePath}`], { stdin: title });
  writeSuccess(null);
}

async function workspaceExec(args: string[]): Promise<void> {
  const id = requireArg(args[0], "workspace id");
  const separatorIndex = args.indexOf("--");
  if (separatorIndex !== 1) throw invalidArguments("usage: atelier workspace exec <workspace-id> -- <command...>");

  const command = args.slice(separatorIndex + 1);
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
  writeSuccess(execResult);
}

async function ensureRepo(id: string, repo: string): Promise<void> {
  validateRepoName(repo);
  const path = repoPath(repo);
  const result = await execShellAsAtelier(id, `test -d ${shellQuote(path)} && git -C ${shellQuote(path)} rev-parse --is-inside-work-tree >/dev/null 2>&1`);
  if (result.exitCode !== 0) throw new CliError("repo_not_found", `repo not found: ${repo}`);
}

async function listRepos(id: string): Promise<string[]> {
  const script = `find ${shellQuote(workspaceRoot)} -mindepth 1 -maxdepth 1 -type d ! -name '.*' -exec sh -c 'for dir do git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 && basename "$dir"; done' sh {} + | sort`;
  const result = await execShellAsAtelier(id, script);
  if (result.exitCode !== 0) throw new CliError("git_error", result.stderr.trim() || "could not list repos");
  return result.stdout.trim().split(/\n+/).filter(Boolean);
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
  if (upstream.exitCode !== 0) throw new CliError("git_error", upstream.stderr.trim() || `could not resolve upstream for ${repo}`);

  const counts = await execShellAsAtelier(id, `git -C ${quotedPath} rev-list --left-right --count '@{upstream}'...HEAD`);
  if (counts.exitCode !== 0) throw new CliError("git_error", counts.stderr.trim() || `could not calculate ahead/behind for ${repo}`);

  const [behindText, aheadText] = counts.stdout.trim().split(/\s+/);
  const behind = Number(behindText);
  const ahead = Number(aheadText);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    throw new CliError("git_error", `could not parse ahead/behind for ${repo}`);
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
  if (mergeCheck.exitCode !== 0) throw new CliError("git_error", mergeCheck.stderr.trim() || `could not calculate mergeability for ${repo}`);

  const output = mergeCheck.stdout.trim();
  if (output === "clean") return { state: "can_push", ahead, behind };

  const match = output.match(/^conflicts\s+(\d+)$/);
  if (match) return { state: "has_conflicts", ahead, behind, conflictCount: Number(match[1]) };

  throw new CliError("git_error", `could not parse mergeability for ${repo}`);
}

async function workspaceRepoList(id: string, args: string[]): Promise<void> {
  if (args.length !== 0) throw invalidArguments("workspace repo list takes no arguments");
  await resolveWorkspace(id);
  writeSuccess({ repos: await listRepos(id) });
}

async function workspaceRepoMergeability(id: string, args: string[]): Promise<void> {
  const repo = requireArg(args[0], "repo name");
  if (args.length !== 1) throw invalidArguments("usage: atelier workspace <workspace-id> repo mergeability <repo>");
  await resolveWorkspace(id);
  writeSuccess(await calculateMergeability(id, repo));
}

async function workspaceRepoPush(id: string, args: string[]): Promise<void> {
  const repo = requireArg(args[0], "repo name");
  if (args.length !== 1) throw invalidArguments("usage: atelier workspace <workspace-id> repo push <repo>");
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
  if (skipped) {
    writeSuccess(skipped);
    return;
  }

  const path = repoPath(repo);
  const rebased = await execShellAsAtelier(id, `git -C ${shellQuote(path)} rebase '@{upstream}'`);
  if (rebased.exitCode !== 0) {
    writeSuccess({ state: "failed", message: (rebased.stderr || rebased.stdout).trim() });
    return;
  }

  const pushed = await execShellAsAtelier(id, `git -C ${shellQuote(path)} push`);
  if (pushed.exitCode !== 0) {
    writeSuccess({ state: "failed", message: (pushed.stderr || pushed.stdout).trim() });
    return;
  }

  writeSuccess({ state: "pushed" });
}

async function workspaceRepoCommand(args: string[]): Promise<void> {
  const id = requireArg(args[0], "workspace id");
  if (args[1] !== "repo") throw invalidArguments("usage: atelier workspace <workspace-id> repo <command>");

  const [command, ...rest] = args.slice(2);
  switch (command) {
    case "list":
      await workspaceRepoList(id, rest);
      return;
    case "mergeability":
      await workspaceRepoMergeability(id, rest);
      return;
    case "push":
      await workspaceRepoPush(id, rest);
      return;
    default:
      throw invalidArguments(`unknown repo command: ${command ?? ""}`);
  }
}

export async function workspaceCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "new":
      await workspaceNew(rest);
      return;
    case "list":
      await workspaceList(rest);
      return;
    case "delete":
      await workspaceDelete(rest);
      return;
    case "title":
      await workspaceTitle(rest);
      return;
    case "exec":
      await workspaceExec(rest);
      return;
    default:
      await workspaceRepoCommand(args);
      return;
  }
}
