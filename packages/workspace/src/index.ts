import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AtelierCoreError, atelierDataPath, currentAtelierContainerImageId, dockerHostAtelierDataPath, getAtelierRuntimeContext, invalidArguments, requireDocker, runDocker, runDockerBuffer, shellQuote, type AtelierEventBus } from "@atelier/core";
import { prepareAtelierWorkspaceImagePreload, resolveWorkspaceImageResolution, type WorkspaceImageResolution } from "@atelier/workspace-image";
import type { WorkspaceCreationContext, WorkspaceDockerMount, WorkspaceDockerPlan, WorkspaceInitInstruction } from "./types.ts";
export type { WorkspaceCreationContext, WorkspaceDockerMount, WorkspaceDockerPlan, WorkspaceInitInstruction, WorkspaceInitInstructionMap } from "./types.ts";

export type {
  WorkspaceAgentTurnFinishedEvent,
  WorkspaceCreatedEvent,
  WorkspaceDeletedEvent,
  WorkspaceDeleteInspectEvent,
  WorkspacePlanPrepareEvent,
  WorkspaceSourcePrepareEvent,
  WorkspaceTabsChangedEvent,
  WorkspaceTitleChangedEvent,
  WorkspaceUserActivityEvent,
} from "./events.ts";

const workspaceTypeLabel = "com.atelier.type";
const namespaceLabel = "com.atelier.namespace";
const workspaceIdLabel = "com.atelier.workspace-id";
const workspaceCreatedByAtelierImageIdLabel = "com.atelier.created-by-image-id";
const titlePath = "title";
const parkedPath = "parked";
const initPath = "init.json";
export const workspaceManifestPath = ".atelier/workspace.json";
const workspaceStartupTimeoutMs = 120_000;
export const workspaceRoot = "/work";
export const workspaceVSCodePort = 8000;
export const workspaceDesktopPort = 6080;
export const workspacePreviewPorts = [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010] as const;

export interface WorkspaceNewResult { id: string }
export interface WorkspaceListResult { workspaces: Array<{ id: string; title: string | null; parked?: boolean; init?: WorkspaceInitInstruction; createdByAtelierImageId?: string }> }
export interface WorkspaceExecResult { exitCode: number; stdout: string; stderr: string; durationMs: number }
export type WorkspaceExecBufferResult = Omit<WorkspaceExecResult, "stdout"> & { stdout: Buffer }
export interface WorkspaceCommandOptions { workdir?: string; user?: "atelier" | "root"; stdin?: string }
export interface DeleteWorkspaceOptions { force?: boolean; events?: AtelierEventBus }
export interface CreateWorkspaceForkOptions { sourceWorkspaceId: string }
export interface CreateWorkspaceOptions { id?: string; events?: AtelierEventBus; init?: WorkspaceInitInstruction; context?: WorkspaceCreationContext; fork?: CreateWorkspaceForkOptions }

function namespace(): string { return process.env.ATELIER_NAMESPACE || "host"; }
export function generateWorkspaceId(): string { return crypto.randomUUID().replaceAll("-", "").slice(0, 8); }
export function workspaceContainerName(id: string): string { return `atelier-${id}`; }

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function workspacePublishHost(): string { return "127.0.0.1"; }
function workspaceConnectHost(): string { return "127.0.0.1"; }
function formatDeleteBlockedMessage(id: string, issues: unknown[]): string { return `workspace ${id} has delete blockers:\n${issues.map((issue) => `- ${JSON.stringify(issue)}`).join("\n")}\nuse --force to delete anyway`; }
async function provisionStep<T>(events: AtelierEventBus | undefined, workspaceId: string, id: string, label: string, fn: () => Promise<T>, options: { parentId?: string; output?: (result: T) => string | Promise<string> } = {}): Promise<T> {
  await events?.emit("workspace_provision_step", { workspaceId, id, label, status: "running", parentId: options.parentId });
  try {
    const result = await fn();
    const output = options.output ? await options.output(result) : undefined;
    await events?.emit("workspace_provision_step", { workspaceId, id, label, status: "done", parentId: options.parentId, output });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await events?.emit("workspace_provision_step", { workspaceId, id, label, status: "failed", parentId: options.parentId, error: message });
    throw error;
  }
}

async function createWorkspaceWorkDir(id: string): Promise<{ worktreePath: string; dockerHostWorktreePath: string }> {
  const runtime = await getAtelierRuntimeContext();
  const worktreePath = atelierDataPath(runtime, "workspaces", id, "work");
  const dockerHostWorktreePath = dockerHostAtelierDataPath(runtime, "workspaces", id, "work");
  if (await Bun.file(worktreePath).exists()) throw new AtelierCoreError("workspace_source_exists", `workspace source already exists: ${worktreePath}`);
  await mkdir(worktreePath, { recursive: true });
  return { worktreePath, dockerHostWorktreePath };
}

async function deleteWorkspaceWorkDir(id: string): Promise<void> {
  const runtime = await getAtelierRuntimeContext();
  await rm(atelierDataPath(runtime, "workspaces", id), { recursive: true, force: true });
}

async function inspectLabels(id: string): Promise<Record<string, string>> {
  const inspected = await runDocker(["inspect", "--format", "{{json .Config.Labels}}", workspaceContainerName(id)]);
  if (inspected.exitCode !== 0) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
  const trimmed = inspected.stdout.trim();
  return trimmed && trimmed !== "null" ? JSON.parse(trimmed) as Record<string, string> : {};
}

async function ensureWorkspaceFilesystem(id: string): Promise<void> {
  const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `test -d ${shellQuote(workspaceRoot)} && test -d /.atelier`]);
  if (result.exitCode !== 0) throw new AtelierCoreError("workspace_repair_failed", result.stderr.trim() || result.stdout.trim() || `workspace filesystem is not ready for ${id}`);
}

async function inspectWorkspaceContainerImage(id: string): Promise<string> {
  await resolveWorkspace(id);
  const inspected = await runDocker(["inspect", "--format", "{{.Image}}", workspaceContainerName(id)]);
  if (inspected.exitCode !== 0) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
  return inspected.stdout.trim();
}

async function workspaceStartupLog(id: string): Promise<string> {
  const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", "tail -n 120 /.atelier/startup.log 2>/dev/null || true"]);
  return result.stdout.trim();
}

async function waitForWorkspaceStartup(id: string): Promise<void> {
  const timeoutSeconds = Math.ceil(workspaceStartupTimeoutMs / 1000);
  const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `deadline=$(( $(date +%s) + ${timeoutSeconds} )); while [ "$(date +%s)" -le "$deadline" ]; do test -f /.atelier/ready && exit 0; sleep 0.05; done; exit 1`]);
  if (result.exitCode === 0) return;
  const log = await workspaceStartupLog(id);
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  throw new AtelierCoreError("workspace_startup_timeout", `workspace did not finish startup: ${id}${output ? `\n${output}` : ""}${log ? `\n\nStartup log:\n${log}` : ""}`);
}

export async function resolveWorkspace(id: string): Promise<string> {
  const labels = await inspectLabels(id);
  if (labels[workspaceTypeLabel] !== "workspace" || labels[namespaceLabel] !== namespace()) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
  await ensureWorkspaceFilesystem(id);
  return id;
}

function assertValidWorkspaceId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw invalidArguments(`invalid workspace id: ${id}`);
}

export function workspaceWorkHostPath(id: string): string {
  assertValidWorkspaceId(id);
  return atelierDataPath(getAtelierRuntimeContext(), "workspaces", id, "work");
}

function workspaceMetadataDir(context: Awaited<ReturnType<typeof getAtelierRuntimeContext>>, id: string): string {
  return atelierDataPath(context, "workspaces", id, "metadata");
}

function workspaceMetadataPath(context: Awaited<ReturnType<typeof getAtelierRuntimeContext>>, id: string, name: string): string {
  return join(workspaceMetadataDir(context, id), name);
}

async function readTitle(context: Awaited<ReturnType<typeof getAtelierRuntimeContext>>, id: string): Promise<string | null> {
  const file = Bun.file(workspaceMetadataPath(context, id, titlePath));
  if (!(await file.exists())) return null;
  return (await file.text()).replace(/\n$/, "");
}

async function readParked(context: Awaited<ReturnType<typeof getAtelierRuntimeContext>>, id: string): Promise<boolean> {
  return await Bun.file(workspaceMetadataPath(context, id, parkedPath)).exists();
}

async function writeWorkspaceInit(context: Awaited<ReturnType<typeof getAtelierRuntimeContext>>, id: string, init: WorkspaceInitInstruction | undefined): Promise<void> {
  if (init === undefined) return;
  await mkdir(workspaceMetadataDir(context, id), { recursive: true });
  await writeFile(workspaceMetadataPath(context, id, initPath), `${JSON.stringify(init, null, 2)}\n`);
}

export async function getWorkspaceInit(id: string): Promise<WorkspaceInitInstruction | undefined> {
  await resolveWorkspace(id);
  const context = await getAtelierRuntimeContext();
  return JSON.parse(await readFile(workspaceMetadataPath(context, id, initPath), "utf8")) as WorkspaceInitInstruction;
}

async function readWorkspaceInit(context: Awaited<ReturnType<typeof getAtelierRuntimeContext>>, id: string): Promise<WorkspaceInitInstruction | undefined> {
  const file = Bun.file(workspaceMetadataPath(context, id, initPath));
  if (!(await file.exists())) return undefined;
  return JSON.parse(await file.text()) as WorkspaceInitInstruction;
}

interface RepoWorkspaceManifest {
  version: 1;
  privileged?: boolean;
  isAtelier?: boolean;
  docker?: { privileged?: boolean };
  initScripts?: string[];
  seedPiConfig?: {
    authJson?: string;
    modelsJson?: string;
  };
}

function optionalString(record: Record<string, unknown>, key: string, path: string, label = key): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw invalidArguments(`invalid ${path}: ${label} must be a non-empty string`);
  return value;
}

function optionalRecord(record: Record<string, unknown>, key: string, path: string): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidArguments(`invalid ${path}: ${key} must be an object`);
  return value as Record<string, unknown>;
}

function parseRepoWorkspaceManifest(text: string, path: string): RepoWorkspaceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalidArguments(`invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidArguments(`invalid ${path}: expected object`);
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) throw invalidArguments(`invalid ${path}: unsupported version`);
  if (record.privileged !== undefined && typeof record.privileged !== "boolean") throw invalidArguments(`invalid ${path}: privileged must be a boolean`);
  if (record.isAtelier !== undefined && typeof record.isAtelier !== "boolean") throw invalidArguments(`invalid ${path}: isAtelier must be a boolean`);
  const dockerRecord = optionalRecord(record, "docker", path);
  if (dockerRecord?.privileged !== undefined && typeof dockerRecord.privileged !== "boolean") throw invalidArguments(`invalid ${path}: docker.privileged must be a boolean`);
  const docker: RepoWorkspaceManifest["docker"] | undefined = dockerRecord ? {} : undefined;
  if (docker && dockerRecord?.privileged !== undefined) docker.privileged = dockerRecord.privileged;
  const initScripts = record.initScripts;
  if (initScripts !== undefined && (!Array.isArray(initScripts) || !initScripts.every((script) => typeof script === "string"))) throw invalidArguments(`invalid ${path}: initScripts must be an array of strings`);
  const seedPiConfigRecord = optionalRecord(record, "seedPiConfig", path);
  const authJson = seedPiConfigRecord ? optionalString(seedPiConfigRecord, "authJson", path, "seedPiConfig.authJson") : undefined;
  const modelsJson = seedPiConfigRecord ? optionalString(seedPiConfigRecord, "modelsJson", path, "seedPiConfig.modelsJson") : undefined;
  return {
    version: 1,
    ...(record.privileged !== undefined ? { privileged: record.privileged } : {}),
    ...(record.isAtelier !== undefined ? { isAtelier: record.isAtelier } : {}),
    ...(docker ? { docker } : {}),
    ...(initScripts ? { initScripts } : {}),
    ...(seedPiConfigRecord ? { seedPiConfig: { ...(authJson ? { authJson } : {}), ...(modelsJson ? { modelsJson } : {}) } } : {}),
  };
}

function seedPiConfigInstallScript(source: string, target: string): string {
  return `seed_src=${shellQuote(source)}; seed_dst=${shellQuote(target)}; mkdir -p "$(dirname "$seed_dst")"; install -o atelier -g atelier -m 600 "$seed_src" "$seed_dst"; rm -f "$seed_src"`;
}

async function applySeedPiConfigManifest(manifest: RepoWorkspaceManifest, plan: WorkspaceDockerPlan): Promise<void> {
  const seed = manifest.seedPiConfig;
  if (!seed) return;
  const runtime = await getAtelierRuntimeContext();
  const entries = [
    seed.authJson ? { source: atelierDataPath(runtime, "pi-config", "auth.json"), staging: "/tmp/atelier-seed-pi-auth.json", target: seed.authJson } : undefined,
    seed.modelsJson ? { source: atelierDataPath(runtime, "pi-config", "models.json"), staging: "/tmp/atelier-seed-pi-models.json", target: seed.modelsJson } : undefined,
  ].filter((entry): entry is { source: string; staging: string; target: string } => Boolean(entry));
  for (const entry of entries) {
    plan.containerFiles.push({ source: entry.source, target: entry.staging });
    plan.initScripts.push(seedPiConfigInstallScript(entry.staging, entry.target));
  }
}

async function applyRepoWorkspaceManifest(sourcePath: string, plan: WorkspaceDockerPlan): Promise<void> {
  const path = join(sourcePath, workspaceManifestPath);
  const file = Bun.file(path);
  if (!(await file.exists())) return;
  const manifest = parseRepoWorkspaceManifest(await file.text(), workspaceManifestPath);
  if ((manifest.privileged || manifest.docker?.privileged) && !plan.extraArgs.includes("--privileged")) plan.extraArgs.push("--privileged");
  if (manifest.isAtelier) plan.preloadAtelierWorkspaceImages = true;
  await applySeedPiConfigManifest(manifest, plan);
  plan.initScripts.push(...(manifest.initScripts ?? []));
}

function workspaceExecDockerArgs(resolved: string, command: string[], options: WorkspaceCommandOptions): string[] {
  return ["exec", ...(options.stdin !== undefined ? ["-i"] : []), "--user", options.user ?? "atelier", "--env", "LANG=C.UTF-8", "--env", "LC_ALL=C.UTF-8", "--workdir", options.workdir ?? workspaceRoot, workspaceContainerName(resolved), ...command];
}

export async function execWorkspaceCommand(id: string, command: string[], options: WorkspaceCommandOptions = {}): Promise<WorkspaceExecResult> {
  if (command.length === 0) throw invalidArguments("command is required");
  const resolved = await resolveWorkspace(id);
  const startedAt = Date.now();
  const result = await runDocker(workspaceExecDockerArgs(resolved, command, options), { stdin: options.stdin });
  return { ...result, durationMs: Date.now() - startedAt };
}
export async function execWorkspaceCommandBuffer(id: string, command: string[], options: WorkspaceCommandOptions = {}): Promise<WorkspaceExecBufferResult> {
  if (command.length === 0) throw invalidArguments("command is required");
  const resolved = await resolveWorkspace(id);
  const startedAt = Date.now();
  const result = await runDockerBuffer(workspaceExecDockerArgs(resolved, command, options), { stdin: options.stdin });
  return { ...result, durationMs: Date.now() - startedAt };
}
export async function execWorkspaceShell(id: string, script: string, options: WorkspaceCommandOptions = {}): Promise<WorkspaceExecResult> { return await execWorkspaceCommand(id, ["sh", "-lc", script], options); }

function dockerMountArg(mount: WorkspaceDockerMount): string { return [`type=${mount.type}`, `src=${mount.source}`, `dst=${mount.target}`, ...(mount.readonly ? ["readonly"] : [])].join(","); }
function planEnvDockerArgs(env: Record<string, string>): string[] { return Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]); }
function workspaceGitCredentialInitScript(): string {
  return `cat > /usr/local/bin/atelier-git-credential <<'EOF'
#!/bin/sh
test "$1" = get || exit 0
[ -n "\${GH_TOKEN:-}" ] || exit 0
echo username=x-access-token
echo password="$GH_TOKEN"
EOF
chmod 755 /usr/local/bin/atelier-git-credential; cat > /etc/profile.d/atelier-github-token.sh <<'EOF'
# GH_TOKEN, when present, is an Atelier placeholder. It is not the real secret.
EOF
su atelier -c ${shellQuote("git config --global credential.helper '!/usr/local/bin/atelier-git-credential'")}`;
}

function hostUserEnv(): Record<string, string> {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") throw new AtelierCoreError("unsupported_platform", "workspace containers require a POSIX host uid/gid");
  const uid = process.getuid();
  const gid = process.getgid();
  if (uid === 0 || gid === 0) throw new AtelierCoreError("unsupported_root_user", "workspace containers require a non-root Atelier process");
  return { ATELIER_HOST_UID: String(uid), ATELIER_HOST_GID: String(gid) };
}

function baseWorkspacePlan(labels: Record<string, string>): WorkspaceDockerPlan {
  return { labels, env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...hostUserEnv() }, mounts: [], publishes: [workspaceVSCodePort, workspaceDesktopPort, ...workspacePreviewPorts], extraArgs: ["--privileged"], initScripts: [workspaceGitCredentialInitScript()], containerFiles: [], cleanup: [] };
}

function alignWorkspaceUserScript(): string {
  return `work_uid="\${ATELIER_HOST_UID:?}"
work_gid="\${ATELIER_HOST_GID:?}"
if [ "$work_uid" = 0 ] || [ "$work_gid" = 0 ]; then echo "Atelier must run as a non-root host user" >&2; exit 1; fi
conflict_user="$(getent passwd "$work_uid" | cut -d: -f1 || true)"
if [ -n "$conflict_user" ] && [ "$conflict_user" != atelier ]; then userdel "$conflict_user"; fi
user_changed=0
if [ "$(id -u atelier)" != "$work_uid" ] || [ "$(id -g atelier)" != "$work_gid" ]; then
  # Do not replace this with usermod/groupmod without profiling workspace startup.
  # usermod recursively rewrote ownership in /home/atelier, including the large
  # prewarmed VS Code tree, and made container startup ~2.5s slower.
  sed -i -E "s/^(atelier:[^:]*:)[0-9]+:[0-9]+:/\\1\${work_uid}:\${work_gid}:/" /etc/passwd
  sed -i -E "s/^(atelier:[^:]*:)[0-9]+:/\\1\${work_gid}:/" /etc/group
  user_changed=1
fi
chown atelier:atelier /home/atelier /.atelier /var/lib/atelier
if [ "$user_changed" = 1 ]; then
  find /home/atelier -mindepth 1 -maxdepth 1 ! -name .vscode -exec chown -R atelier:atelier {} +
  if [ -d /home/atelier/.vscode ]; then chown atelier:atelier /home/atelier/.vscode; fi
fi`;
}

function workspaceStartupPreambleScript(): string {
  return `set -eu
mkdir -p /.atelier
startup_started_at_ms="$(($(date +%s%N) / 1000000))"
startup_log_path=/.atelier/startup.log
: > "$startup_log_path"
startup_now_ms() { now_ns="$(date +%s%N)"; echo "$((now_ns / 1000000))"; }
startup_log_step() { now_ms="$(startup_now_ms)"; printf '%s +%sms %s\\n' "$now_ms" "$((now_ms - startup_started_at_ms))" "$1" >> "$startup_log_path"; }
startup_log_failure() { status=$?; if [ "$status" -ne 0 ]; then startup_log_step "failed status=$status"; fi; }
trap startup_log_failure EXIT
startup_log_step start`;
}

function workspaceInitStepScript(id: string, script: string): string {
  return `startup_log_step ${shellQuote(`${id}.start`)}
{ ${script}
}
startup_log_step ${shellQuote(`${id}.done`)}`;
}

function workspaceStartVSCodeScript(): string {
  return `if command -v atelier-start-vscode >/dev/null 2>&1; then su atelier -c 'ATELIER_VSCODE_DEFAULT_FOLDER=${workspaceRoot} nohup atelier-start-vscode > /.atelier/vscode-server.log 2>&1 &' || true; elif command -v code >/dev/null 2>&1; then su atelier -c 'nohup code serve-web --accept-server-license-terms --host 0.0.0.0 --port ${workspaceVSCodePort} --without-connection-token --default-folder ${workspaceRoot} > /.atelier/vscode-server.log 2>&1 &' || true; fi`;
}

function workspaceInitScript(plan: WorkspaceDockerPlan): string {
  return [
    workspaceStartupPreambleScript(),
    workspaceInitStepScript("align-user", alignWorkspaceUserScript()),
    workspaceInitStepScript("atelier-dir", `install -d -o atelier -g atelier /.atelier`),
    ...plan.initScripts.map((script, index) => workspaceInitStepScript(`init-${index + 1}`, script)),
    workspaceInitStepScript("vscode-start", workspaceStartVSCodeScript()),
    "touch /.atelier/ready",
    "startup_log_step ready",
    "trap - EXIT",
    "sleep infinity",
  ].join("\n");
}

export async function createWorkspace(options: CreateWorkspaceOptions = {}): Promise<WorkspaceNewResult> {
  const id = options.id ?? generateWorkspaceId();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw invalidArguments(`invalid workspace id: ${id}`);
  const context = options.context && Object.keys(options.context).length ? options.context : undefined;
  const init = options.init;
  const source = await provisionStep(options.events, id, "workspace.workdir", "Create workspace directory", () => createWorkspaceWorkDir(id));
  let plan: WorkspaceDockerPlan | undefined;
  try {
    const fork = options.fork;
    const forkImage = fork ? await provisionStep(options.events, id, "workspace.fork", "Copy workspace files", async () => {
      const image = await inspectWorkspaceContainerImage(fork.sourceWorkspaceId);
      await cp(workspaceWorkHostPath(fork.sourceWorkspaceId), source.worktreePath, { recursive: true, preserveTimestamps: true });
      return image;
    }) : undefined;
    await writeWorkspaceInit(await getAtelierRuntimeContext(), id, init);
    if (!fork) {
      await provisionStep(options.events, id, "workspace.source", "Prepare workspace source", async () => {
        await options.events?.emit("workspace_source_prepare", { workspaceId: id, init, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot });
      });
    }
    const currentImageId = currentAtelierContainerImageId();
    const labels: Record<string, string> = { [workspaceTypeLabel]: "workspace", [namespaceLabel]: namespace(), [workspaceIdLabel]: id, ...(currentImageId ? { [workspaceCreatedByAtelierImageIdLabel]: currentImageId } : {}) };
    plan = baseWorkspacePlan(labels);
    plan.mounts.push({ type: "bind", source: source.dockerHostWorktreePath, target: workspaceRoot });
    const activePlan = plan;
    await provisionStep(options.events, id, "workspace.plan", "Prepare workspace container plan", async () => {
      await applyRepoWorkspaceManifest(source.worktreePath, activePlan);
      await options.events?.emit("workspace_plan_prepare", { workspaceId: id, init, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot, plan: activePlan });
    });
    let imageResolution: WorkspaceImageResolution | undefined;
    if (!activePlan.image && !forkImage) {
      imageResolution = await provisionStep(options.events, id, "workspace.image", "Resolve workspace image", () => resolveWorkspaceImageResolution({ workspaceId: id, events: options.events, sourcePath: source.worktreePath }));
      activePlan.image = imageResolution.image;
    } else {
      activePlan.image ??= forkImage;
    }
    // Preloading is only prepared for images resolved for this source tree. Forks
    // reuse the source workspace container image, so they skip this repo-image
    // optimization instead of guessing tags for an arbitrary image id.
    if (activePlan.preloadAtelierWorkspaceImages && imageResolution) {
      const preload = await provisionStep(options.events, id, "workspace.image-preload", "Prepare Atelier image preload", () => prepareAtelierWorkspaceImagePreload({ sourcePath: source.worktreePath, resolution: imageResolution }), { output: (preload) => preload.refs.join("\n") });
      activePlan.mounts.push(preload.mount);
      activePlan.initScripts.push(preload.initScript);
    }
    await provisionStep(options.events, id, "workspace.container", "Start workspace container", async () => {
      const image = activePlan.image;
      if (!image) throw new AtelierCoreError("workspace_image_missing", "workspace image was not resolved");
      const publishHost = workspacePublishHost();
      const container = workspaceContainerName(id);
      await requireDocker(["create", "--restart", "unless-stopped", "--name", container, ...Object.entries(activePlan.labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]), ...activePlan.publishes.flatMap((port) => ["--publish", `${publishHost}::${port}`]), ...planEnvDockerArgs(activePlan.env), ...activePlan.extraArgs, ...activePlan.mounts.flatMap((mount) => ["--mount", dockerMountArg(mount)]), "--user", "root", image, "sh", "-lc", workspaceInitScript(activePlan)]);
      for (const file of activePlan.containerFiles) await requireDocker(["cp", file.source, `${container}:${file.target}`]);
      await requireDocker(["start", container]);
    });
    await provisionStep(options.events, id, "workspace.startup", "Wait for workspace startup", () => waitForWorkspaceStartup(id), { output: () => workspaceStartupLog(id) });
    await provisionStep(options.events, id, "workspace.verify", "Verify workspace", () => resolveWorkspace(id));
  } catch (error) {
    await runDocker(["rm", "-f", workspaceContainerName(id)]).catch(() => undefined);
    await Promise.all((plan?.cleanup ?? []).map((cleanup) => Promise.resolve(cleanup()).catch(() => undefined)));
    await deleteWorkspaceWorkDir(id).catch(() => undefined);
    throw error;
  }
  return { id };
}

interface WorkspacePublishedEndpoint { host: string; port: number }

const workspacePublishedEndpointCache = new Map<string, Promise<WorkspacePublishedEndpoint>>();

function workspacePublishedEndpointCacheKey(id: string, containerPort: number): string {
  return `${namespace()}\0${id}\0${containerPort}`;
}

function clearWorkspacePublishedEndpointCache(id: string): void {
  const prefix = `${namespace()}\0${id}\0`;
  for (const key of workspacePublishedEndpointCache.keys()) {
    if (key.startsWith(prefix)) workspacePublishedEndpointCache.delete(key);
  }
}

async function inspectWorkspacePublishedEndpoint(id: string, containerPort: number): Promise<WorkspacePublishedEndpoint> {
  await resolveWorkspace(id);
  const result = await runDocker(["port", workspaceContainerName(id), `${containerPort}/tcp`]);
  if (result.exitCode !== 0) throw new AtelierCoreError("workspace_port_not_found", result.stderr.trim() || `workspace ${id} does not publish port ${containerPort}`);
  const line = result.stdout.trim().split(/\n+/)[0] ?? "";
  const match = line.match(/^\[([^\]]+)\]:(\d+)$/) ?? line.match(/^(.+):(\d+)$/);
  if (!match) throw new AtelierCoreError("workspace_port_not_found", `could not parse published port for ${id}:${containerPort}: ${line}`);
  return { host: match[1]!, port: Number(match[2]!) };
}

async function workspacePublishedEndpoint(id: string, containerPort: number): Promise<WorkspacePublishedEndpoint> {
  const key = workspacePublishedEndpointCacheKey(id, containerPort);
  const cached = workspacePublishedEndpointCache.get(key);
  if (cached) return await cached;

  const inspected = inspectWorkspacePublishedEndpoint(id, containerPort).catch((error) => {
    workspacePublishedEndpointCache.delete(key);
    throw error;
  });
  workspacePublishedEndpointCache.set(key, inspected);
  return await inspected;
}

async function reachableWorkspacePublishedEndpoint(id: string, containerPort: number): Promise<WorkspacePublishedEndpoint> {
  const endpoint = await workspacePublishedEndpoint(id, containerPort);
  return { host: workspaceConnectHost(), port: endpoint.port };
}

function endpointAuthority({ host, port }: WorkspacePublishedEndpoint): string {
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

export async function workspacePortUrl(id: string, containerPort: number, pathAndSearch: string, protocol = "http:"): Promise<URL> {
  const path = pathAndSearch.startsWith("/") ? pathAndSearch : `/${pathAndSearch}`;
  return new URL(path, `${protocol}//${endpointAuthority(await reachableWorkspacePublishedEndpoint(id, containerPort))}`);
}

export async function workspacePreviewPortUrl(id: string, containerPort: number, pathAndSearch: string, protocol = "http:"): Promise<URL> {
  if (!(workspacePreviewPorts as readonly number[]).includes(containerPort)) throw invalidArguments(`unsupported workspace preview port: ${containerPort}. Supported ports: ${workspacePreviewPorts.join(", ")}`);
  return await workspacePortUrl(id, containerPort, pathAndSearch, protocol);
}

export async function listWorkspaces(): Promise<WorkspaceListResult> {
  const context = await getAtelierRuntimeContext();
  const listed = await requireDocker(["ps", "-a", "--filter", `label=${workspaceTypeLabel}=workspace`, "--filter", `label=${namespaceLabel}=${namespace()}`, "--format", `{{.ID}}\t{{.Label "${workspaceIdLabel}"}}\t{{.Label "${workspaceCreatedByAtelierImageIdLabel}"}}`]);
  const workspaces: WorkspaceListResult["workspaces"] = [];
  for (const line of listed.stdout.trim().split(/\n+/).filter(Boolean)) {
    const [containerId, labelledId, createdByAtelierImageId] = line.split("\t");
    if (!containerId) continue;
    const id = labelledId?.trim() || containerId.slice(0, 8);
    const parked = await readParked(context, id);
    const init = await readWorkspaceInit(context, id);
    workspaces.push({ id, title: await readTitle(context, id), ...(parked ? { parked } : {}), ...(init !== undefined ? { init } : {}), ...(createdByAtelierImageId?.trim() ? { createdByAtelierImageId: createdByAtelierImageId.trim() } : {}) });
  }
  return { workspaces };
}

export async function deleteWorkspace(id: string, options: DeleteWorkspaceOptions = {}): Promise<null> {
  assertValidWorkspaceId(id);
  let containerExists = true;
  if (options.force) {
    const labels = await inspectLabels(id).catch((error) => {
      if (error instanceof AtelierCoreError && error.code === "workspace_not_found") return undefined;
      throw error;
    });
    if (labels && (labels[workspaceTypeLabel] !== "workspace" || labels[namespaceLabel] !== namespace())) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
    containerExists = labels !== undefined;
  } else {
    await resolveWorkspace(id);
    const issues: unknown[] = [];
    await options.events?.emit("workspace_delete_inspect", { workspaceId: id, issues });
    if (issues.length > 0) throw new AtelierCoreError("workspace_delete_blocked", formatDeleteBlockedMessage(id, issues), { workspaceId: id, issues });
  }
  if (containerExists) await requireDocker(["rm", "-f", workspaceContainerName(id)]);
  clearWorkspacePublishedEndpointCache(id);
  await options.events?.emit("workspace_deleted", { workspaceId: id });
  await deleteWorkspaceWorkDir(id);
  return null;
}

export async function setWorkspaceTitle(id: string, title: string): Promise<null> {
  await resolveWorkspace(id);
  const context = await getAtelierRuntimeContext();
  await mkdir(workspaceMetadataDir(context, id), { recursive: true });
  await writeFile(workspaceMetadataPath(context, id, titlePath), title);
  return null;
}

export async function setWorkspaceParked(id: string, parked: boolean): Promise<null> {
  await resolveWorkspace(id);
  const context = await getAtelierRuntimeContext();
  await mkdir(workspaceMetadataDir(context, id), { recursive: true });
  const path = workspaceMetadataPath(context, id, parkedPath);
  if (parked) await writeFile(path, "");
  else await rm(path, { force: true });
  return null;
}

