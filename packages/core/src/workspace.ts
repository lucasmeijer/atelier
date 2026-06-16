import { requireDocker, runDocker } from "./docker.ts";
import { AtelierCoreError, invalidArguments } from "./errors.ts";
import type { AtelierEventBus } from "./events.ts";
import { parseRepositorySpec } from "./repository.ts";
import { dockerHostAtelierDataPath, getAtelierRuntimeContext } from "./runtime-context.ts";
import { resolveWorkspaceImage } from "./workspace-image.ts";
import { ensureAtelierWorkspaceProxy, ensureWorkspaceProxyAuthToken, forgetWorkspaceProxyAuthToken, workspaceProxyUrl } from "./proxy/egress-proxy.ts";
import { ensureMitmCa } from "./proxy/mitm-ca.ts";
import { createWorkspaceSecretContext, forgetWorkspaceSecretContext } from "./secrets/workspace-secrets.ts";

const workspaceTypeLabel = "com.atelier.type";
const namespaceLabel = "com.atelier.namespace";
const titlePath = "/.atelier/title";
export const workspaceRoot = "/work";
export const workspaceVSCodePort = 8000;
export const workspacePreviewPorts = [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010] as const;

const workspaceUtf8Environment = ["--env", "LANG=C.UTF-8", "--env", "LC_ALL=C.UTF-8"];
const workspaceMitmCaPath = "/run/atelier-mitm-ca.crt";

export interface WorkspaceNewResult {
  id: string;
}

export interface WorkspaceListResult {
  workspaces: Array<{
    id: string;
    title: string | null;
    sourceRepositoryId?: string | null;
  }>;
}

export interface WorkspaceExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface WorkspaceCommandOptions {
  workdir?: string;
  user?: "atelier" | "root";
  stdin?: string;
}

export interface WorkspaceCommandContext {
  events?: AtelierEventBus;
}

export interface WorkspaceRepoListResult {
  repos: string[];
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

const workspaceIdLabel = "com.atelier.workspace-id";
export const workspaceSourceRepositoryLabel = "com.atelier.source-repo";

function namespace(): string {
  return process.env.ATELIER_NAMESPACE || "default";
}

export function generateWorkspaceId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

export function workspaceContainerName(id: string): string {
  return `atelier-${id}`;
}

function workspacePublishHost(): string {
  return process.env.ATELIER_WORKSPACE_PUBLISH_HOST || "127.0.0.1";
}

function workspaceProxyEnvArgs(workspaceId: string, token: string): string[] {
  const proxy = workspaceProxyUrl(workspaceId, token);
  return [
    "--env", `HTTP_PROXY=${proxy}`,
    "--env", `HTTPS_PROXY=${proxy}`,
    "--env", `http_proxy=${proxy}`,
    "--env", `https_proxy=${proxy}`,
    "--env", "NO_PROXY=localhost,127.0.0.1,::1",
    "--env", "no_proxy=localhost,127.0.0.1,::1",
    "--env", "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
    "--env", "REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt",
    "--env", "CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt",
    "--env", "NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/atelier-mitm-ca.crt",
    "--env", "GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt",
    "--env", "NPM_CONFIG_CAFILE=/etc/ssl/certs/ca-certificates.crt",
    "--env", "YARN_CA_FILE=/etc/ssl/certs/ca-certificates.crt",
    "--env", "PIP_CERT=/etc/ssl/certs/ca-certificates.crt",
  ];
}

function secretEnvDockerArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}

function dockerHostGatewayArgs(): string[] {
  return ["--add-host", "host.docker.internal:host-gateway"];
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw invalidArguments(`missing ${name}`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const singleWorkspaceRepoName = "work";
const workspaceGitCloneTerminalTitle = "Cloning repository";

function repoPath(repo: string): string {
  validateRepoName(repo);
  if (repo !== singleWorkspaceRepoName) throw new AtelierCoreError("repo_not_found", `repo not found: ${repo}`);
  return workspaceRoot;
}

function validateRepoName(repo: string): void {
  if (repo === "" || repo.includes("/") || repo === "." || repo === "..") {
    throw invalidArguments(`invalid repo name: ${repo}`);
  }
}

async function execAsAtelier(id: string, command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await runDocker(["exec", "--user", "atelier", workspaceContainerName(id), ...command]);
}

async function execShellAsAtelier(id: string, script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await execAsAtelier(id, ["sh", "-lc", script]);
}

async function inspectLabels(id: string): Promise<Record<string, string>> {
  const inspected = await runDocker(["inspect", "--format", "{{json .Config.Labels}}", workspaceContainerName(id)]);
  if (inspected.exitCode !== 0) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);

  const trimmed = inspected.stdout.trim();
  return trimmed && trimmed !== "null" ? JSON.parse(trimmed) as Record<string, string> : {};
}

async function ensureWorkspaceFilesystem(id: string): Promise<void> {
  const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `
    set -e
    if [ ! -e ${shellQuote(workspaceRoot)} ] && [ -d /workspace/repos ]; then
      mv /workspace/repos ${shellQuote(workspaceRoot)}
    fi
    if [ ! -e ${shellQuote(workspaceRoot)} ] && [ -d /repos ]; then
      mv /repos ${shellQuote(workspaceRoot)}
    fi
    mkdir -p ${shellQuote(workspaceRoot)} /.atelier
    chown -R atelier:atelier ${shellQuote(workspaceRoot)} /.atelier
  `]);
  if (result.exitCode !== 0) throw new AtelierCoreError("workspace_repair_failed", result.stderr.trim() || result.stdout.trim() || `could not prepare workspace filesystem for ${id}`);
}

async function waitForWorkspaceStartup(id: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `test -d ${shellQuote(workspaceRoot)} && test -x /usr/local/bin/atelier-git-credential`]);
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new AtelierCoreError("workspace_startup_timeout", `workspace did not finish startup: ${id}`);
}

export async function resolveWorkspace(id: string): Promise<string> {
  const labels = await inspectLabels(id);
  if (labels[workspaceTypeLabel] !== "workspace" || labels[namespaceLabel] !== namespace()) {
    throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
  }
  await ensureWorkspaceFilesystem(id);
  return id;
}

async function readTitle(containerRef: string): Promise<string | null> {
  const result = await runDocker(["exec", containerRef, "cat", titlePath]);
  if (result.exitCode !== 0) return null;
  return result.stdout.replace(/\n$/, "");
}

export async function execWorkspaceCommand(
  id: string,
  command: string[],
  options: WorkspaceCommandOptions = {},
): Promise<WorkspaceExecResult> {
  if (command.length === 0) throw invalidArguments("command is required");
  const resolved = await resolveWorkspace(id);
  const startedAt = Date.now();
  const dockerArgs = [
    "exec",
    ...(options.stdin !== undefined ? ["-i"] : []),
    "--user",
    options.user ?? "atelier",
    ...workspaceUtf8Environment,
    "--workdir",
    options.workdir ?? workspaceRoot,
    workspaceContainerName(resolved),
    ...command,
  ];
  const result = await runDocker(dockerArgs, { stdin: options.stdin });
  return { ...result, durationMs: Date.now() - startedAt };
}

export async function execWorkspaceShell(
  id: string,
  script: string,
  options: WorkspaceCommandOptions = {},
): Promise<WorkspaceExecResult> {
  return await execWorkspaceCommand(id, ["sh", "-lc", script], options);
}

export interface CreateWorkspaceOptions {
  id?: string;
  events?: AtelierEventBus;
  sourceRepositoryId?: string;
  gitUrl?: string | null;
  gitBranch?: string | null;
}

export async function createWorkspace(options: CreateWorkspaceOptions = {}): Promise<WorkspaceNewResult> {
  const id = options.id ?? generateWorkspaceId();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw invalidArguments(`invalid workspace id: ${id}`);
  const image = await resolveWorkspaceImage({ workspaceId: id, events: options.events });
  const runtimeContext = await getAtelierRuntimeContext();

  try {
    const secretContext = await createWorkspaceSecretContext(id);
    const proxyAuthToken = await ensureWorkspaceProxyAuthToken(id);
    await ensureAtelierWorkspaceProxy();
    const mitmCa = await ensureMitmCa(runtimeContext);
    const dockerHostMitmCaPath = dockerHostAtelierDataPath(runtimeContext, "proxy-ca", "atelier-mitm-ca.pem");

    await requireDocker([
    "run",
    "-d",
    "--name",
    workspaceContainerName(id),
    "--label",
    `${workspaceTypeLabel}=workspace`,
    "--label",
    `${namespaceLabel}=${namespace()}`,
    "--label",
    `${workspaceIdLabel}=${id}`,
    ...(options.sourceRepositoryId ? ["--label", `${workspaceSourceRepositoryLabel}=${options.sourceRepositoryId}`] : []),
    "--publish",
    `${workspacePublishHost()}::${workspaceVSCodePort}`,
    ...workspacePreviewPorts.flatMap((port) => ["--publish", `${workspacePublishHost()}::${port}`]),
    ...workspaceUtf8Environment,
    ...dockerHostGatewayArgs(),
    ...secretEnvDockerArgs(secretContext.env),
    ...workspaceProxyEnvArgs(id, proxyAuthToken),
    "--mount", `type=bind,src=${dockerHostMitmCaPath},dst=${workspaceMitmCaPath},readonly`,
    "--user",
    "root",
    image,
    "sh",
    "-lc",
    `mkdir -p /.atelier ${workspaceRoot}; chown -R atelier:atelier /.atelier ${workspaceRoot}; if [ -r ${workspaceMitmCaPath} ]; then mkdir -p /usr/local/share/ca-certificates; cp ${workspaceMitmCaPath} /usr/local/share/ca-certificates/atelier-mitm-ca.crt; update-ca-certificates || true; fi; cat > /usr/local/bin/atelier-git-credential <<'EOF'
#!/bin/sh
test "$1" = get || exit 0
[ -n "\${GH_TOKEN:-}" ] || exit 0
echo username=x-access-token
echo password="$GH_TOKEN"
EOF
chmod 755 /usr/local/bin/atelier-git-credential; cat > /etc/profile.d/atelier-github-token.sh <<'EOF'
# GH_TOKEN, when present, is an Atelier placeholder. It is not the real secret.
EOF
git config --file /home/atelier/.gitconfig user.name 'Lucas Meijer'; git config --file /home/atelier/.gitconfig user.email lucas@lucasmeijer.com; git config --file /home/atelier/.gitconfig credential.helper '!/usr/local/bin/atelier-git-credential'; git config --file /home/atelier/.gitconfig http.proxy "$HTTPS_PROXY"; git config --file /home/atelier/.gitconfig http.proxyAuthMethod basic; chown atelier:atelier /home/atelier/.gitconfig; if command -v atelier-start-vscode >/dev/null 2>&1; then su atelier -c 'ATELIER_VSCODE_DEFAULT_FOLDER=${workspaceRoot} nohup atelier-start-vscode > /.atelier/vscode-server.log 2>&1 &' || true; elif command -v code >/dev/null 2>&1; then su atelier -c 'nohup code serve-web --accept-server-license-terms --host 0.0.0.0 --port ${workspaceVSCodePort} --without-connection-token --default-folder ${workspaceRoot} > /.atelier/vscode-server.log 2>&1 &' || true; fi; sleep infinity`,
    ]);

    await waitForWorkspaceStartup(id);
    await resolveWorkspace(id);
    await waitForWorkspaceInit(id);
    const gitUrl = options.gitUrl?.trim();
    if (gitUrl) await cloneGitUrlIntoWorkspace(id, gitUrl, { events: options.events, branch: options.gitBranch?.trim() || null });
  } catch (error) {
    await runDocker(["rm", "-f", workspaceContainerName(id)]).catch(() => undefined);
    await forgetWorkspaceProxyAuthToken(id).catch(() => undefined);
    forgetWorkspaceSecretContext(id);
    throw error;
  }

  return { id };
}

export async function getWorkspacePublishedPort(id: string, containerPort: number): Promise<number> {
  await resolveWorkspace(id);
  const result = await runDocker(["port", workspaceContainerName(id), `${containerPort}/tcp`]);
  if (result.exitCode !== 0) throw new AtelierCoreError("workspace_port_not_found", result.stderr.trim() || `workspace ${id} does not publish port ${containerPort}`);
  const line = result.stdout.trim().split(/\n+/)[0] ?? "";
  const match = line.match(/(?:0\.0\.0\.0|127\.0\.0\.1|\[?::1\]?):(\d+)$/) ?? line.match(/:(\d+)$/);
  const port = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(port) || port <= 0) throw new AtelierCoreError("workspace_port_not_found", `could not parse published port for ${id}:${containerPort}: ${line}`);
  return port;
}

export async function getWorkspaceVSCodePort(id: string): Promise<number> {
  return await getWorkspacePublishedPort(id, workspaceVSCodePort);
}

export async function getWorkspacePreviewPort(id: string, containerPort: number): Promise<number> {
  if (!(workspacePreviewPorts as readonly number[]).includes(containerPort)) {
    throw invalidArguments(`unsupported workspace preview port: ${containerPort}. Supported ports: ${workspacePreviewPorts.join(", ")}`);
  }
  return await getWorkspacePublishedPort(id, containerPort);
}

export async function listWorkspaces(): Promise<WorkspaceListResult> {

  const listed = await requireDocker([
    "ps",
    "-a",
    "--filter",
    `label=${workspaceTypeLabel}=workspace`,
    "--filter",
    `label=${namespaceLabel}=${namespace()}`,
    "--format",
    `{{.ID}}\t{{.Label "${workspaceIdLabel}"}}\t{{.Label "${workspaceSourceRepositoryLabel}"}}`,
  ]);

  const workspaces: WorkspaceListResult["workspaces"] = [];
  for (const line of listed.stdout.trim().split(/\n+/).filter(Boolean)) {
    const [containerId, labelledId, sourceRepositoryId] = line.split("\t");
    if (!containerId) continue;
    // Workspaces created before app-generated ids carry no workspace-id label;
    // their id is the 8-char container id prefix (their container is named atelier-<prefix>).
    const id = labelledId?.trim() || containerId.slice(0, 8);
    const source = sourceRepositoryId?.trim();
    workspaces.push({ id, title: await readTitle(containerId), ...(source ? { sourceRepositoryId: source } : {}) });
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
  await requireDocker(["rm", "-f", workspaceContainerName(id)]);
  await forgetWorkspaceProxyAuthToken(id);
  forgetWorkspaceSecretContext(id);
  return null;
}

export async function setWorkspaceTitle(id: string, title: string): Promise<null> {
  await resolveWorkspace(id);

  await requireDocker(["exec", "-i", workspaceContainerName(id), "sh", "-c", `mkdir -p /.atelier && cat > ${titlePath}`], { stdin: title });
  return null;
}

export async function execWorkspace(id: string, command: string[]): Promise<WorkspaceExecResult> {
  if (command.length === 0) throw invalidArguments("workspace exec requires a command");
  return await execWorkspaceCommand(id, command);
}

async function ensureRepo(id: string, repo: string): Promise<void> {
  validateRepoName(repo);
  const path = repoPath(repo);
  const result = await execShellAsAtelier(id, `test -d ${shellQuote(path)} && git -C ${shellQuote(path)} rev-parse --is-inside-work-tree >/dev/null 2>&1`);
  if (result.exitCode !== 0) throw new AtelierCoreError("repo_not_found", `repo not found: ${repo}`);
}

async function waitForWorkspaceInit(id: string): Promise<void> {
  const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `for i in $(seq 1 100); do test -x /usr/local/bin/atelier-git-credential && test -f /home/atelier/.gitconfig && exit 0; sleep 0.1; done; exit 1`]);
  if (result.exitCode !== 0) throw new AtelierCoreError("workspace_init_failed", result.stderr.trim() || result.stdout.trim() || `workspace ${id} did not finish initializing`);
}

async function listRepos(id: string): Promise<string[]> {
  const result = await execShellAsAtelier(id, `mkdir -p ${shellQuote(workspaceRoot)} && git -C ${shellQuote(workspaceRoot)} rev-parse --is-inside-work-tree >/dev/null 2>&1`);
  return result.exitCode === 0 ? [singleWorkspaceRepoName] : [];
}

async function cloneGitUrlIntoWorkspace(id: string, gitUrl: string, options: { branch?: string | null; events?: AtelierEventBus } = {}): Promise<void> {
  const trimmed = gitUrl.trim();
  if (!trimmed) throw invalidArguments("missing git URL");
  const branch = options.branch?.trim() || null;
  const branchArgs = branch ? ` --branch ${shellQuote(branch)}` : "";
  const exitPath = `/.atelier/git-clone-${Date.now()}.exit`;
  const script = `
    set -e
    mkdir -p ${shellQuote(workspaceRoot)} /.atelier
    if git -C ${shellQuote(workspaceRoot)} rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      printf 'repo already exists at %s\\n' ${shellQuote(workspaceRoot)} >&2
      echo 17 > ${shellQuote(exitPath)}
      exit 17
    fi
    if find ${shellQuote(workspaceRoot)} -mindepth 1 -maxdepth 1 | read _; then
      printf 'workspace directory is not empty: %s\\n' ${shellQuote(workspaceRoot)} >&2
      echo 17 > ${shellQuote(exitPath)}
      exit 17
    fi
    printf '\\033[36mCloning %s%s into ${workspaceRoot}...\\033[0m\\n' ${shellQuote(trimmed)} ${shellQuote(branch ? `#${branch}` : "")}
    set +e
    git clone --progress${branchArgs} ${shellQuote(trimmed)} ${shellQuote(workspaceRoot)}
    status=$?
    set -e
    if [ "$status" -eq 0 ]; then
      printf '\\n\\033[32mClone complete.\\033[0m\\n'
    else
      printf '\\n\\033[31mClone failed with exit code %s.\\033[0m\\n' "$status"
    fi
    echo "$status" > ${shellQuote(exitPath)}
    exit "$status"
  `;
  const start = await execShellAsAtelier(
    id,
    `tmux kill-session -t ${shellQuote(workspaceGitCloneTerminalTitle)} 2>/dev/null || true
     tmux new-session -d -s ${shellQuote(workspaceGitCloneTerminalTitle)} -c / /bin/bash -lc ${shellQuote(script)} \\; set-option -t ${shellQuote(workspaceGitCloneTerminalTitle)} status off`,
  );
  if (start.exitCode !== 0) throw new AtelierCoreError("git_clone_failed", start.stderr.trim() || start.stdout.trim() || `could not start clone for ${trimmed}`);

  const event = { workspaceId: id, gitUrl: branch ? `${trimmed}#${branch}` : trimmed, terminalTitle: workspaceGitCloneTerminalTitle };
  await options.events?.emit("workspace_git_clone_started", event);

  async function fail(code: "repo_already_exists" | "git_clone_failed", message: string): Promise<never> {
    await options.events?.emit("workspace_git_clone_finished", { ...event, error: message });
    throw new AtelierCoreError(code, message);
  }

  const deadline = Date.now() + 30 * 60 * 1000;
  for (;;) {
    const status = await execShellAsAtelier(id, `cat ${shellQuote(exitPath)} 2>/dev/null`);
    if (status.exitCode === 0 && status.stdout.trim()) {
      const code = Number(status.stdout.trim());
      if (code === 0) {
        await options.events?.emit("workspace_git_clone_finished", event);
        return;
      }
      const message = code === 17 ? `workspace directory is not empty: ${workspaceRoot}` : `could not clone ${trimmed}`;
      return await fail(code === 17 ? "repo_already_exists" : "git_clone_failed", message);
    }
    const alive = await execShellAsAtelier(id, `tmux has-session -t ${shellQuote(workspaceGitCloneTerminalTitle)} 2>/dev/null`);
    if (alive.exitCode !== 0) return await fail("git_clone_failed", `git clone session exited without reporting status for ${trimmed}`);
    if (Date.now() > deadline) return await fail("git_clone_failed", `git clone timed out for ${trimmed}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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

export async function workspaceCommand(args: string[], context: WorkspaceCommandContext = {}): Promise<unknown> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "new": {
      if (rest.length > 1) throw invalidArguments("usage: atelier workspace new [git-url]");
      const repoSpec = rest[0] ? parseRepositorySpec(rest[0]) : undefined;
      const created = await createWorkspace({ events: context.events, gitUrl: repoSpec?.gitUrl ?? null, gitBranch: repoSpec?.branch ?? null });
      await context.events?.emit("workspace_created", { workspaceId: created.id, context: repoSpec ? { gitUrl: repoSpec.gitUrl, gitBranch: repoSpec.branch } : undefined });
      return created;
    }
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
      return await workspaceRepoCommand(args);
  }
}
