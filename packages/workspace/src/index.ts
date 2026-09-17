import { createHash } from "node:crypto";
import { workspaceImagePreloader } from "./preload.ts";
import type { WorkspaceImageConfigureEvent } from "./events.ts";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AtelierCoreError, atelierDataPath, createProcessFileLock, dockerHostAtelierDataPath, getAtelierRuntimeContext, gitHubCredentialHelperShellBody, invalidArguments, isJsonObject, requireDocker, runDocker, runDockerBuffer, withManagedDockerCommand, withCommandSignal, waitForCommand, shellQuote, type AtelierEventBus, type CommandInput, type JsonObject } from "@atelier/core";
import { runHostObservableCommand, stripTerminalControls, tailTerminalText } from "@atelier/observable-terminal/server";
import { isWorkspaceAppPort, workspaceGatewayPort, type WorkspaceGateway, type WorkspaceHttpAppBackend, type WorkspaceServerProvisioningHook } from "@atelier/shared";
import { inspectWorkspaceImage, resolveWorkspaceImage } from "@atelier/workspace-image";
import { prepareWorkspaceSystemd } from "./systemd.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { seedConfigInstallScript } from "./startup-scripts.ts";
import type { WorkspaceCreationContext, WorkspaceDockerMount, WorkspaceDockerPlan, WorkspaceInitInstruction } from "./types.ts";
export type { WorkspaceCreationContext, WorkspaceDockerMount, WorkspaceDockerPlan, WorkspaceInitInstruction, WorkspaceInitInstructionMap } from "./types.ts";

export type {
  WorkspaceAgentPromptPreparingEvent,
  WorkspaceAgentPromptSubmittedEvent,
  WorkspaceAgentTurnFinishedEvent,
  WorkspaceAgentViewInvalidatedEvent,
  WorkspaceCreatedEvent,
  WorkspaceDeletedEvent,
  WorkspaceDeleteInspectEvent,
  WorkspacePlanPrepareEvent,
  WorkspaceSourcePrepareEvent,
  WorkspaceTitleChangedEvent,
  WorkspaceUserActivityEvent,
} from "./events.ts";

export { createWorkspaceMetadataState, type WorkspaceMetadataState } from "./metadata-state.ts";
export { createWorkspaceProvisioning, type WorkspaceProvisioning, type WorkspaceProvisionRun, type WorkspaceProvisionStep } from "./provisioning.ts";
import type { WorkspaceProvisionRun } from "./provisioning.ts";

export {
  createWorkspacePresentationStore,
  type WorkspacePresentationStore,
  type WorkspacePresentationStoreOptions,
  type WorkspaceWorkViewContribution,
  type WorkspaceWorkViewReference,
  type WorkspaceWorkViewState,
} from "./presentation.ts";

const workspaceTypeLabel = "com.atelier.type";
const namespaceLabel = "com.atelier.namespace";
const workspaceIdLabel = "com.atelier.workspace-id";
const titlePath = "title";
const parkedPath = "parked";
const initPath = "init.json";
const workspaceManifestPath = ".atelier/workspace.json";
const workspaceStartupTimeoutMs = 5 * 60_000;
const withWorkspaceIdentityLock = createProcessFileLock({
  label: "workspace identity tombstone",
  lockDir: () => atelierDataPath(getAtelierRuntimeContext(), "workspaces", "identity-tombstones.lock"),
});
const dockerLabelsSchema = Type.Record(Type.String(), Type.String());
const booleanSchema = Type.Boolean();
const nonBlankStringSchema = Type.String({ pattern: "\\S" });
const stringArraySchema = Type.Array(Type.String());
export const workspaceRoot = "/work";
export const workspaceVSCodePort = 8000;

export interface WorkspaceListResult { workspaces: Array<{ id: string; title: string | null; parked?: boolean; init?: WorkspaceInitInstruction; imageOutdated?: boolean }> }
export interface WorkspaceExecResult { exitCode: number; stdout: string; stderr: string; durationMs: number }
export type WorkspaceExecBufferResult = Omit<WorkspaceExecResult, "stdout"> & { stdout: Buffer }
export interface WorkspaceCommandOptions { workdir?: string; user?: "atelier" | "root"; stdin?: CommandInput }
export interface DeleteWorkspaceOptions { force?: boolean; events?: AtelierEventBus }

function namespace(): string { return process.env.ATELIER_NAMESPACE || "host"; }
export function generateWorkspaceId(): string { return crypto.randomUUID().replaceAll("-", "").slice(0, 8); }
export function workspaceContainerName(id: string): string { return `atelier-${id}`; }

export function workspaceNetworkName(id: string): string { return `atelier-workspace-${id}`; }
export function workspaceBridgeName(id: string): string { return `atw-${createHash("sha256").update(id).digest("hex").slice(0, 11)}`; }
function formatDeleteBlockedMessage(id: string, issues: JsonObject[]): string { return `workspace ${id} has delete blockers:\n${issues.map((issue) => `- ${JSON.stringify(issue)}`).join("\n")}\nuse --force to delete anyway`; }

async function createWorkspaceWorkDir(id: string): Promise<{ worktreePath: string; dockerHostWorktreePath: string }> {
  const runtime = getAtelierRuntimeContext();
  const worktreePath = atelierDataPath(runtime, "workspaces", id, "work");
  const dockerHostWorktreePath = dockerHostAtelierDataPath(runtime, "workspaces", id, "work");
  if (await Bun.file(worktreePath).exists()) throw new AtelierCoreError("workspace_source_exists", `workspace source already exists: ${worktreePath}`);
  await mkdir(worktreePath, { recursive: true });
  return { worktreePath, dockerHostWorktreePath };
}

async function deleteWorkspaceWorkDir(id: string): Promise<void> {
  const runtime = getAtelierRuntimeContext();
  await rm(atelierDataPath(runtime, "workspaces", id), { recursive: true, force: true });
}

async function inspectLabels(id: string): Promise<Record<string, string>> {
  const inspected = await runDocker(["inspect", "--format", "{{json .Config.Labels}}", workspaceContainerName(id)]);
  if (inspected.exitCode !== 0) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
  const trimmed = inspected.stdout.trim();
  return trimmed && trimmed !== "null" ? Value.Parse(dockerLabelsSchema, JSON.parse(trimmed)) : {};
}

async function ensureWorkspaceFilesystem(id: string): Promise<void> {
  const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `test -d ${shellQuote(workspaceRoot)} && test -d /.atelier`]);
  if (result.exitCode !== 0) throw new AtelierCoreError("workspace_repair_failed", result.stderr.trim() || result.stdout.trim() || `workspace filesystem is not ready for ${id}`);
}

async function waitForWorkspaceStartup(id: string): Promise<string> {
  const timeoutSeconds = Math.ceil(workspaceStartupTimeoutMs / 1000);
  const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `deadline=$(( $(date +%s) + ${timeoutSeconds} )); while [ "$(date +%s)" -le "$deadline" ]; do if test -f /.atelier/ready; then cat /.atelier/startup.log; exit 0; fi; if test -S /run/systemd/private && systemctl is-failed --quiet atelier-init.service atelier-gateway.service; then break; fi; sleep 0.05; done; tail -n 120 /.atelier/startup.log; journalctl --no-pager -n 120 -u atelier-init.service -u atelier-gateway.service; exit 1`]);
  const log = result.stdout.trim();
  if (result.exitCode === 0) return log;
  const output = result.stderr.trim();
  throw new AtelierCoreError("workspace_startup_timeout", `workspace did not finish startup: ${id}${output ? `\n${output}` : ""}${log ? `\n\nStartup log:\n${log}` : ""}`);
}

async function validateWorkspaceContainer(id: string): Promise<void> {
  assertValidWorkspaceId(id);
  const labels = await inspectLabels(id);
  if (labels[workspaceTypeLabel] !== "workspace" || labels[namespaceLabel] !== namespace()) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
}

export async function resolveWorkspace(id: string): Promise<string> {
  await validateWorkspaceContainer(id);
  await ensureWorkspaceFilesystem(id);
  return id;
}

export async function isWorkspaceRunning(id: string): Promise<boolean> {
  await validateWorkspaceContainer(id);
  const result = await runDocker(["inspect", "--format", "{{.State.Running}}", workspaceContainerName(id)]);
  if (result.exitCode !== 0) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
  return result.stdout.trim() === "true";
}

function assertValidWorkspaceId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw invalidArguments(`invalid workspace id: ${id}`);
}

function workspaceIdentityTombstonePath(): string {
  return atelierDataPath(getAtelierRuntimeContext(), "workspaces", "identity-tombstones.json");
}

async function readRetiredWorkspaceIds(): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(workspaceIdentityTombstonePath(), "utf8"));
    return new Set(Value.Parse(stringArraySchema, parsed));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set();
    throw error;
  }
}

function workspaceIdentityKey(id: string): string {
  return `${namespace()}\0${id}`;
}

async function isRetiredWorkspaceId(id: string): Promise<boolean> {
  return await withWorkspaceIdentityLock(async () => (await readRetiredWorkspaceIds()).has(workspaceIdentityKey(id)));
}

async function retireWorkspaceId(id: string): Promise<void> {
  await withWorkspaceIdentityLock(async () => {
    const retired = await readRetiredWorkspaceIds();
    retired.add(workspaceIdentityKey(id));
    const path = workspaceIdentityTombstonePath();
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...retired].sort(), null, 2)}\n`);
    await rename(temporary, path);
  });
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
  return await readWorkspaceInit(getAtelierRuntimeContext(), id);
}

async function readWorkspaceInit(context: Awaited<ReturnType<typeof getAtelierRuntimeContext>>, id: string): Promise<WorkspaceInitInstruction | undefined> {
  const file = Bun.file(workspaceMetadataPath(context, id, initPath));
  if (!(await file.exists())) return undefined;
  // SAFETY: This internal file serializes the open, declaration-merged
  // WorkspaceInitInstruction union; feature consumers validate concrete variants.
  return JSON.parse(await file.text()) as WorkspaceInitInstruction;
}

export interface RepoWorkspaceManifest {
  version: 1;
  docker?: { privileged?: boolean };
  initScripts?: string[];
  seedPiConfig?: {
    authJson?: string;
    modelsJson?: string;
    modelsStoreJson?: string;
  };
  seedAtelierConfig?: {
    projectsJson?: string;
  };
}

function optionalString(record: JsonObject, key: string, path: string, label = key): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Value.Check(nonBlankStringSchema, value)) throw invalidArguments(`invalid ${path}: ${label} must be a non-empty string`);
  return value;
}

function optionalBoolean(record: JsonObject, key: string, path: string, label = key): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Value.Check(booleanSchema, value)) throw invalidArguments(`invalid ${path}: ${label} must be a boolean`);
  return value;
}

function optionalRecord(record: JsonObject, key: string, path: string): JsonObject | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) throw invalidArguments(`invalid ${path}: ${key} must be an object`);
  return value;
}

export function parseRepoWorkspaceManifest(text: string, path = workspaceManifestPath): RepoWorkspaceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalidArguments(`invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isJsonObject(parsed)) throw invalidArguments(`invalid ${path}: expected object`);
  const record = parsed;
  if (record.version !== 1) throw invalidArguments(`invalid ${path}: unsupported version`);
  if (record.privileged !== undefined) throw invalidArguments(`invalid ${path}: privileged is no longer supported; use docker.privileged`);
  if (record.isAtelier !== undefined) throw invalidArguments(`invalid ${path}: isAtelier is no longer supported`);
  const dockerRecord = optionalRecord(record, "docker", path);
  const privileged = dockerRecord ? optionalBoolean(dockerRecord, "privileged", path, "docker.privileged") : undefined;
  const docker: RepoWorkspaceManifest["docker"] | undefined = dockerRecord ? {} : undefined;
  if (docker && privileged !== undefined) docker.privileged = privileged;
  const initScripts = record.initScripts;
  if (initScripts !== undefined && !Value.Check(stringArraySchema, initScripts)) throw invalidArguments(`invalid ${path}: initScripts must be an array of strings`);
  const seedPiConfigRecord = optionalRecord(record, "seedPiConfig", path);
  const authJson = seedPiConfigRecord ? optionalString(seedPiConfigRecord, "authJson", path, "seedPiConfig.authJson") : undefined;
  const modelsJson = seedPiConfigRecord ? optionalString(seedPiConfigRecord, "modelsJson", path, "seedPiConfig.modelsJson") : undefined;
  const modelsStoreJson = seedPiConfigRecord ? optionalString(seedPiConfigRecord, "modelsStoreJson", path, "seedPiConfig.modelsStoreJson") : undefined;
  const seedAtelierConfigRecord = optionalRecord(record, "seedAtelierConfig", path);
  const projectsJson = seedAtelierConfigRecord ? optionalString(seedAtelierConfigRecord, "projectsJson", path, "seedAtelierConfig.projectsJson") : undefined;
  const manifest: RepoWorkspaceManifest = { version: 1 };
  if (docker) manifest.docker = docker;
  if (initScripts) manifest.initScripts = initScripts;
  if (seedPiConfigRecord) {
    manifest.seedPiConfig = {};
    if (authJson) manifest.seedPiConfig.authJson = authJson;
    if (modelsJson) manifest.seedPiConfig.modelsJson = modelsJson;
    if (modelsStoreJson) manifest.seedPiConfig.modelsStoreJson = modelsStoreJson;
  }
  if (seedAtelierConfigRecord) {
    manifest.seedAtelierConfig = {};
    if (projectsJson) manifest.seedAtelierConfig.projectsJson = projectsJson;
  }
  return manifest;
}

function applySeedConfigManifest(manifest: RepoWorkspaceManifest, plan: WorkspaceDockerPlan): void {
  const runtime = getAtelierRuntimeContext();
  // systemd mounts a fresh /tmp during boot, hiding files copied there before start.
  const entries = [
    manifest.seedPiConfig?.authJson ? { source: atelierDataPath(runtime, "pi-config", "auth.json"), staging: "/.atelier/seed-pi-auth.json", target: manifest.seedPiConfig.authJson } : undefined,
    manifest.seedPiConfig?.modelsJson ? { source: atelierDataPath(runtime, "pi-config", "models.json"), staging: "/.atelier/seed-pi-models.json", target: manifest.seedPiConfig.modelsJson } : undefined,
    manifest.seedPiConfig?.modelsStoreJson ? { source: atelierDataPath(runtime, "pi-config", "models-store.json"), staging: "/.atelier/seed-pi-models-store.json", target: manifest.seedPiConfig.modelsStoreJson } : undefined,
    manifest.seedAtelierConfig?.projectsJson ? { source: atelierDataPath(runtime, "projects.json"), staging: "/.atelier/seed-projects.json", target: manifest.seedAtelierConfig.projectsJson } : undefined,
  ].filter((entry): entry is { source: string; staging: string; target: string } => Boolean(entry));
  for (const entry of entries) {
    plan.containerFiles.push({ source: entry.source, target: entry.staging });
    plan.initScripts.push(seedConfigInstallScript(entry.staging, entry.target));
  }
}

async function readRepoWorkspaceManifest(sourcePath: string): Promise<RepoWorkspaceManifest | undefined> {
  const file = Bun.file(join(sourcePath, workspaceManifestPath));
  if (!(await file.exists())) return undefined;
  return parseRepoWorkspaceManifest(await file.text(), workspaceManifestPath);
}

async function applyRepoWorkspaceManifest(sourcePath: string, plan: WorkspaceDockerPlan): Promise<void> {
  const manifest = await readRepoWorkspaceManifest(sourcePath);
  if (!manifest) return;
  if (manifest.docker?.privileged && !plan.extraArgs.includes("--privileged")) plan.extraArgs.push("--privileged");
  applySeedConfigManifest(manifest, plan);
  plan.initScripts.push(...(manifest.initScripts ?? []));
}

function workspaceExecDockerArgs(resolved: string, command: string[], options: WorkspaceCommandOptions, terminal = false): string[] {
  return ["exec", ...(terminal ? ["--interactive", "--tty"] : options.stdin !== undefined ? ["-i"] : []), "--user", options.user ?? "atelier", "--env", "LANG=C.UTF-8", "--env", "LC_ALL=C.UTF-8", "--workdir", options.workdir ?? workspaceRoot, workspaceContainerName(resolved), ...command];
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

const workspaceSetupScript = ".atelier/setup.sh";
export const workspaceSetupProvisioningHook: WorkspaceServerProvisioningHook = {
  id: "workspace.setup",
  label: "Run project setup",
  recovery: "continue",
  async run({ workspaceId: id, events }) {
    if (!(await Bun.file(join(workspaceWorkHostPath(id), workspaceSetupScript)).exists())) {
      await events?.emit("workspace_provision_progress", { workspaceId: id, detail: `No ${workspaceSetupScript}` });
      return;
    }

    const session = `atelier-provision-setup-${crypto.randomUUID().slice(0, 8)}`;
    const result = await withManagedDockerCommand(workspaceExecDockerArgs(id, ["sh", workspaceSetupScript], {}, true), (args) => runHostObservableCommand({
      session,
      cwd: "/",
      command: ["docker", ...args].map(shellQuote).join(" "),
      onSessionStarted: async () => {
        await events?.emit("workspace_provision_progress", { workspaceId: id, terminalSession: session });
      },
    }));
    const output = tailTerminalText(stripTerminalControls(result.output));
    await events?.emit("workspace_provision_progress", { workspaceId: id, output });
    if (result.exitCode !== 0) throw new AtelierCoreError("workspace_setup_failed", output || `${workspaceSetupScript} failed with exit code ${result.exitCode}`);
  },
};

function dockerMountArg(mount: WorkspaceDockerMount): string {
  return [`type=${mount.type}`, ...(mount.source === undefined ? [] : [`src=${mount.source}`]), `dst=${mount.target}`, ...(mount.readonly ? ["readonly"] : [])].join(",");
}

function planEnvDockerArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}

function workspaceCreateDockerArgs(container: string, image: string, plan: WorkspaceDockerPlan): string[] {
  return [
    "create",
    "--restart", "unless-stopped",
    "--name", container,
    ...Object.entries(plan.labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]),
    "--network", workspaceNetworkName(plan.labels[workspaceIdLabel]!),
    ...planEnvDockerArgs(plan.env),
    ...plan.extraArgs,
    ...plan.mounts.flatMap((mount) => ["--mount", dockerMountArg(mount)]),
    "--user", "root",
    image,
    "/usr/local/bin/atelier-workspace-init",
  ];
}

function workspaceGitCredentialInitScript(): string {
  return `cat > /usr/local/bin/atelier-git-credential <<'EOF'
#!/bin/sh
${gitHubCredentialHelperShellBody}
EOF
chmod 755 /usr/local/bin/atelier-git-credential; cat > /etc/profile.d/atelier-github-token.sh <<'EOF'
# GH_TOKEN, when present, is an Atelier placeholder. It is not the real secret.
EOF
su atelier -c ${shellQuote("git config --global credential.helper '!/usr/local/bin/atelier-git-credential'")}`;
}

interface WorkspaceEnvironment {
  [name: string]: string;
}

function hostUserEnv(): WorkspaceEnvironment {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new AtelierCoreError("unsupported_platform", "workspace containers require a POSIX host uid/gid");
  if (uid === 0 || gid === 0) throw new AtelierCoreError("unsupported_root_user", "workspace containers require a non-root Atelier process");
  return { ATELIER_HOST_UID: String(uid), ATELIER_HOST_GID: String(gid) };
}

function baseWorkspacePlan(labels: Record<string, string>): WorkspaceDockerPlan {
  return { labels, env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...hostUserEnv() }, mounts: [], preloadImages: [], extraArgs: [], initScripts: [workspaceGitCredentialInitScript()], containerFiles: [], cleanup: [] };
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
  # Keep ownership changes explicit below instead of letting usermod recursively
  # rewrite large image-provided caches in /home/atelier.
  sed -i -E "s/^(atelier:[^:]*:)[0-9]+:[0-9]+:/\\1\${work_uid}:\${work_gid}:/" /etc/passwd
  sed -i -E "s/^(atelier:[^:]*:)[0-9]+:/\\1\${work_gid}:/" /etc/group
  user_changed=1
fi
chown atelier:atelier /home/atelier /.atelier
if [ "$user_changed" = 1 ]; then
  find /home/atelier -mindepth 1 -maxdepth 1 -exec chown -R atelier:atelier {} +
  if [ -d /.atelier/vscode ]; then chown -R atelier:atelier /.atelier/vscode; fi
  # VS Code writes its extensions manifest here, outside the home directory.
  # Keep installed extensions writable after aligning the image user to the host.
  if [ -d /opt/atelier/vscode-extensions ]; then chown -R atelier:atelier /opt/atelier/vscode-extensions; fi
fi`;
}

function workspaceStartupPreambleScript(): string {
  return `set -eu
mkdir -p /.atelier
rm -f /.atelier/ready
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

function workspaceInitScript(plan: WorkspaceDockerPlan): string {
  return [
    workspaceStartupPreambleScript(),
    workspaceInitStepScript("gateway-credential", "chown root:root /etc/atelier-workspace-gateway-token; chmod 600 /etc/atelier-workspace-gateway-token"),
    workspaceInitStepScript("align-user", alignWorkspaceUserScript()),
    workspaceInitStepScript("atelier-dir", `install -d -o atelier -g atelier /.atelier`),
    ...plan.initScripts.map((script, index) => workspaceInitStepScript(`init-${index + 1}`, script)),
    "startup_log_step gateway.start",
    "trap - EXIT",
  ].join("\n");
}

export async function createWorkspace(options: { id: string; events: AtelierEventBus; init?: WorkspaceInitInstruction; context?: WorkspaceCreationContext; run: WorkspaceProvisionRun }): Promise<void> {
  const { id, events, run } = options;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw invalidArguments(`invalid workspace id: ${id}`);
  if (await isRetiredWorkspaceId(id)) throw invalidArguments(`workspace id has been permanently retired and cannot be reused: ${id}`);
  const context = options.context && Object.keys(options.context).length ? options.context : undefined;
  const init = options.init;
  const source = await run.step("workspace.workdir", "Create workspace directory", () => createWorkspaceWorkDir(id));
  let plan: WorkspaceDockerPlan | undefined;
  try {
    await run.step("workspace.source", "Prepare workspace source", async () => {
      await writeWorkspaceInit(getAtelierRuntimeContext(), id, init);
      await events.emit("workspace_source_prepare", { workspaceId: id, init, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot });
    });
    const activePlan = await run.step("workspace.plan", "Prepare workspace container plan", async () => {
      const labels = { [workspaceTypeLabel]: "workspace", [namespaceLabel]: namespace(), [workspaceIdLabel]: id } satisfies Record<string, string>;
      const activePlan = baseWorkspacePlan(labels);
      plan = activePlan;
      const gatewayTokenPath = atelierDataPath(getAtelierRuntimeContext(), "workspaces", id, "gateway-token");
      await writeFile(gatewayTokenPath, crypto.randomUUID() + crypto.randomUUID(), { mode: 0o600 });
      activePlan.containerFiles.push({ source: gatewayTokenPath, target: "/etc/atelier-workspace-gateway-token" });
      activePlan.mounts.push({ type: "bind", source: source.dockerHostWorktreePath, target: workspaceRoot });
      const sockets = atelierDataPath(getAtelierRuntimeContext(), "workspace-sockets", id);
      await mkdir(sockets, { recursive: true });
      activePlan.mounts.push({ type: "volume", target: "/data" });
      activePlan.mounts.push({ type: "bind", source: "/data/erofs-cache", target: "/data/erofs-cache", readonly: true });
      activePlan.mounts.push({ type: "bind", source: dockerHostAtelierDataPath(getAtelierRuntimeContext(), "workspace-sockets", id), target: "/run/atelier-parent", readonly: true });
      await applyRepoWorkspaceManifest(source.worktreePath, activePlan);
      await events.emit("workspace_plan_prepare", { workspaceId: id, init, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot, plan: activePlan });
      return activePlan;
    });
    if (!activePlan.image) {
      activePlan.image = await run.step("workspace.image", "Resolve workspace image", async () => {
        const configuration: WorkspaceImageConfigureEvent = { init };
        await events.emit("workspace_image_configure", configuration);
        return resolveWorkspaceImage({ workspaceId: id, events, sourcePath: source.worktreePath, dockerfile: configuration.dockerfile });
      });
    }
    const defaultWorkspaceFile = await run.step("workspace.preload-resolve", "Save configured preload images", () => workspaceImagePreloader.snapshot(activePlan.preloadImages, atelierDataPath(getAtelierRuntimeContext(), "workspaces", id)));
    if (defaultWorkspaceFile) activePlan.containerFiles.push({ source: dirname(defaultWorkspaceFile), target: "/etc" });
    await run.step("workspace.container", "Start workspace container", async () => {
      await prepareWorkspaceSystemd(activePlan, atelierDataPath(getAtelierRuntimeContext(), "workspaces", id, "systemd"), workspaceInitScript(activePlan));
      const image = activePlan.image;
      if (!image) throw new AtelierCoreError("workspace_image_missing", "workspace image was not resolved");
      const container = workspaceContainerName(id);
      await requireDocker(["network", "create", "--driver", "bridge", "--opt", `com.docker.network.bridge.name=${workspaceBridgeName(id)}`, "--label", `${workspaceTypeLabel}=workspace-network`, "--label", `${workspaceIdLabel}=${id}`, workspaceNetworkName(id)]);
      await requireDocker(workspaceCreateDockerArgs(container, image, activePlan));
      for (const file of activePlan.containerFiles) await requireDocker(["cp", file.source, `${container}:${file.target}`]);
      await requireDocker(["start", container]);
    });
    await run.step("workspace.startup", "Prepare workspace", async () => {
      const log = await waitForWorkspaceStartup(id);
      run.report({ output: log });
      await checkWorkspaceReadiness(id, (detail) => run.report({ detail }));
    }, "retry-or-continue");
  } catch (error) {
    // Cancellation hands ownership to deletion, which reviews files before removing them.
    if (run.signal.aborted) throw error;
    try {
      const removed = await runDocker(["rm", "-f", "--volumes", workspaceContainerName(id)]);
      if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) throw new Error(removed.stderr.trim() || "could not remove failed workspace container");
      const networks = await requireDocker(["network", "ls", "--quiet", "--filter", `name=^${workspaceNetworkName(id).replaceAll(".", "\\.")}$`]);
      if (networks.stdout.trim()) await requireDocker(["network", "rm", workspaceNetworkName(id)]);
      await events.emit("workspace_deleted", { workspaceId: id });
      await rm(atelierDataPath(getAtelierRuntimeContext(), "workspace-sockets", id), { recursive: true, force: true });
      await Promise.all((plan?.cleanup ?? []).map((cleanup) => cleanup()));
      await deleteWorkspaceWorkDir(id);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `workspace ${id} provisioning and cleanup failed; ownership records retained`);
    }
    throw error;
  }
}

const workspaceGatewayCache = new Map<string, Promise<WorkspaceGateway>>();

function workspaceGatewayCacheKey(id: string): string {
  return `${namespace()}\0${id}`;
}

async function inspectWorkspaceGateway(id: string): Promise<WorkspaceGateway> {
  await resolveWorkspace(id);
  const result = await requireDocker(["inspect", "--format", `{{with index .NetworkSettings.Networks "${workspaceNetworkName(id)}"}}{{.IPAddress}}{{end}}`, workspaceContainerName(id)]);
  const address = result.stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) throw new AtelierCoreError("workspace_gateway_unavailable", `Workspace ${id} has no address on its dedicated network`);
  const token = await readFile(atelierDataPath(getAtelierRuntimeContext(), "workspaces", id, "gateway-token"), "utf8");
  return { url: new URL(`http://${address}:${workspaceGatewayPort}`), token };
}

async function workspaceGateway(id: string): Promise<WorkspaceGateway> {
  const key = workspaceGatewayCacheKey(id);
  let gateway = workspaceGatewayCache.get(key);
  if (!gateway) {
    gateway = withCommandSignal(AbortSignal.timeout(30_000), () => inspectWorkspaceGateway(id)).catch((error) => {
      workspaceGatewayCache.delete(key);
      throw error;
    });
    workspaceGatewayCache.set(key, gateway);
  }
  return await waitForCommand(gateway);
}

/** Resolve any workspace-local web app through the workspace gateway on its dedicated bridge. */
export async function workspacePortBackend(id: string, port: number, pathAndSearch: string, protocol = "http:"): Promise<WorkspaceHttpAppBackend> {
  if (!isWorkspaceAppPort(port)) throw invalidArguments(`Invalid workspace app port ${port}: use 1–65535, except reserved gateway port ${workspaceGatewayPort}`);
  if (protocol !== "http:" && protocol !== "https:") throw invalidArguments("Workspace apps must use HTTP or HTTPS");
  const path = pathAndSearch.startsWith("/") ? pathAndSearch : `/${pathAndSearch}`;
  // Concatenation, not URL resolution: // in an app path must never change hosts.
  const target = new URL(`${protocol}//127.0.0.1:${port}${path}`);
  return { kind: "http", target, gateway: await workspaceGateway(id) };
}

export async function workspaceImageOutdated(id: string, container = workspaceContainerName(id), events?: AtelierEventBus): Promise<boolean> {
  const configuration: WorkspaceImageConfigureEvent = { init: await readWorkspaceInit(getAtelierRuntimeContext(), id) };
  await events?.emit("workspace_image_configure", configuration);
  const [expectedImageId, actualImage] = await Promise.all([
    inspectWorkspaceImage({ sourcePath: workspaceWorkHostPath(id), dockerfile: configuration.dockerfile }),
    requireDocker(["inspect", "--format", "{{.Image}}", container]),
  ]);
  return expectedImageId === undefined || actualImage.stdout.trim() !== expectedImageId;
}

/** Discovery can skip image inspection so server startup only reads workspace identity. */
export async function listWorkspaces(options: { inspectImages?: boolean; events?: AtelierEventBus } = {}): Promise<WorkspaceListResult> {
  const context = getAtelierRuntimeContext();
  const listed = await requireDocker(["ps", "-a", "--filter", `label=${workspaceTypeLabel}=workspace`, "--filter", `label=${namespaceLabel}=${namespace()}`, "--format", `{{.ID}}\t{{.Label "${workspaceIdLabel}"}}`]);
  const workspaces = await Promise.all(listed.stdout.trim().split(/\n+/).filter(Boolean).map(async (line) => {
    const [containerId, labelledId] = line.split("\t");
    const id = labelledId?.trim() || containerId!.slice(0, 8);
    const [parked, init, title, imageOutdated] = await Promise.all([
      readParked(context, id),
      readWorkspaceInit(context, id),
      readTitle(context, id),
      options.inspectImages === false ? false : workspaceImageOutdated(id, containerId, options.events),
    ]);
    const workspace: WorkspaceListResult["workspaces"][number] = { id, title };
    if (parked) workspace.parked = parked;
    if (init !== undefined) workspace.init = init;
    if (imageOutdated) workspace.imageOutdated = imageOutdated;
    return workspace;
  }));
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
    const issues: JsonObject[] = [];
    await options.events?.emit("workspace_delete_inspect", { workspaceId: id, issues });
    if (issues.length > 0) throw new AtelierCoreError("workspace_delete_blocked", formatDeleteBlockedMessage(id, issues), { workspaceId: id, issues });
  }
  // Join workspace consumers while their container and persisted files still exist.
  await options.events?.emit("workspace_deleting", { workspaceId: id });
  if (containerExists) await requireDocker(["rm", "-f", "--volumes", workspaceContainerName(id)]);
  const networks = await requireDocker(["network", "ls", "--quiet", "--filter", `name=^${workspaceNetworkName(id).replaceAll(".", "\\.")}$`]);
  if (networks.stdout.trim()) await requireDocker(["network", "rm", workspaceNetworkName(id)]);
  await retireWorkspaceId(id);
  workspaceGatewayCache.delete(workspaceGatewayCacheKey(id));
  await options.events?.emit("workspace_deleted", { workspaceId: id });
  await rm(atelierDataPath(getAtelierRuntimeContext(), "workspace-sockets", id), { recursive: true, force: true });
  await deleteWorkspaceWorkDir(id);
  return null;
}

export async function getWorkspaceTitle(id: string): Promise<string | null> {
  await resolveWorkspace(id);
  return await readTitle(getAtelierRuntimeContext(), id);
}

export async function setWorkspaceTitle(id: string, title: string): Promise<null> {
  await resolveWorkspace(id);
  const context = getAtelierRuntimeContext();
  await mkdir(workspaceMetadataDir(context, id), { recursive: true });
  await writeFile(workspaceMetadataPath(context, id, titlePath), title);
  return null;
}

async function updateWorkspaceContainerRunning(id: string, running: boolean): Promise<void> {
  const name = workspaceContainerName(id);
  await requireDocker(running ? ["start", name] : ["stop", "--time", "10", name]);
  workspaceGatewayCache.delete(workspaceGatewayCacheKey(id));
}

/** Give the gateway 15 seconds to boot before reporting a recoverable startup failure. */
export async function checkWorkspaceGateway(id: string): Promise<void> {
  await workspaceGateway(id);
  const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `deadline=$(( $(date +%s) + 15 )); while [ "$(date +%s)" -lt "$deadline" ]; do if test "$(curl --noproxy '*' --silent --max-time 1 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:${workspaceGatewayPort}/)" = 401; then exit 0; fi; sleep 0.05; done; exit 1`]);
  if (result.exitCode !== 0) throw new AtelierCoreError("workspace_gateway_unavailable", `Workspace gateway did not become ready within 15 seconds.${result.stderr.trim() ? `\n${result.stderr.trim()}` : ""}`);
}

export async function setWorkspaceContainerRunning(id: string, running: boolean): Promise<null> {
  await validateWorkspaceContainer(id);
  await updateWorkspaceContainerRunning(id, running);
  return null;
}

export async function setWorkspaceParked(id: string, parked: boolean): Promise<null> {
  await validateWorkspaceContainer(id);
  const context = getAtelierRuntimeContext();
  await mkdir(workspaceMetadataDir(context, id), { recursive: true });
  const path = workspaceMetadataPath(context, id, parkedPath);
  if (parked) await writeFile(path, "");
  await updateWorkspaceContainerRunning(id, !parked);
  if (!parked) await rm(path, { force: true });
  return null;
}

/** Repeated on resume and app recovery; the persisted list never rereads project settings. */
export async function checkWorkspaceReadiness(id: string, report: (detail: string) => void = () => {}): Promise<void> {
  report("Checking workspace gateway");
  await checkWorkspaceGateway(id);
  for (const socket of ["ingress", "egress"]) {
    report(`Checking ${socket} proxy`);
    await requireDocker(["exec", "--user", "root", workspaceContainerName(id), "curl", "--noproxy", "*", "--fail", "--silent", "--max-time", "5", "--unix-socket", `/run/atelier-parent/${socket}.sock`, "http://localhost/health"]);
  }
  report("Checking workspace image service");
  await requireDocker(["exec", "--user", "root", workspaceContainerName(id), "curl", "--noproxy", "*", "--fail", "--silent", "--max-time", "5", "http://127.0.0.1:58124/health"]);
  report("Resolving required images");
  const images = await workspaceImagePreloader.load(atelierDataPath(getAtelierRuntimeContext(), "workspaces", id), report);
  await workspaceImagePreloader.install(images, workspaceContainerName(id), report);
}
