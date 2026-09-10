import type { WorkspaceImageConfigureEvent } from "./events.ts";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { AtelierCoreError, atelierDataPath, createProcessFileLock, dockerHostAtelierDataPath, getAtelierRuntimeContext, gitHubCredentialHelperShellBody, invalidArguments, isJsonObject, requireDocker, runDocker, runDockerBuffer, shellQuote, type AtelierEventBus, type CommandInput, type JsonObject } from "@atelier/core";
import { runHostObservableCommand, stripTerminalControls, tailTerminalText } from "@atelier/observable-terminal/server";
import { isWorkspaceAppPort, workspaceGatewayPort, type WorkspaceGateway, type WorkspaceHttpAppBackend, type WorkspaceServerProvisioningHook } from "@atelier/shared";
import { ensureDefaultWorkspaceImage, inspectWorkspaceImage, nativeLinuxDockerPlatform, nestedDockerDaemonInitScript, prepareWorkspaceImageCarrier, prepareSharedImagePreload, resolveDockerImagePreload, resolveWorkspaceImageResolution, type WorkspaceImageResolution } from "@atelier/workspace-image";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readDockerRuntimeConnection, registerWorkspaceDocker, retireWorkspaceDocker } from "./docker-runtime.ts";
import { prepareSharedDocker } from "./shared-docker.ts";
export type { SharedDockerRuntime } from "./shared-docker.ts";
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
export { runWorkspaceProvisioningHooks, type RunWorkspaceProvisioningHooksOptions, type WorkspaceProvisionStepEvent, type WorkspaceProvisionStepStatus, type WorkspaceProvisionTerminal } from "./provisioning.ts";

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
const workspaceCgroupParentLabel = "com.atelier.workspace-cgroup-parent";
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
const nonBlankStringArraySchema = Type.Array(nonBlankStringSchema);
export const workspaceRoot = "/work";
export const workspaceVSCodePort = 8000;

export interface WorkspaceNewResult { id: string }
export interface WorkspaceListResult { workspaces: Array<{ id: string; title: string | null; parked?: boolean; init?: WorkspaceInitInstruction; imageOutdated?: boolean }> }
export interface WorkspaceExecResult { exitCode: number; stdout: string; stderr: string; durationMs: number }
export type WorkspaceExecBufferResult = Omit<WorkspaceExecResult, "stdout"> & { stdout: Buffer }
export interface WorkspaceCommandOptions { workdir?: string; user?: "atelier" | "root"; stdin?: CommandInput }
export interface DeleteWorkspaceOptions { force?: boolean; events?: AtelierEventBus }
export interface CreateWorkspaceForkOptions { sourceWorkspaceId: string }
export interface CreateWorkspaceOptions { id?: string; events?: AtelierEventBus; init?: WorkspaceInitInstruction; context?: WorkspaceCreationContext; fork?: CreateWorkspaceForkOptions }

function namespace(): string { return process.env.ATELIER_NAMESPACE || "host"; }
export function generateWorkspaceId(): string { return crypto.randomUUID().replaceAll("-", "").slice(0, 8); }
export function workspaceContainerName(id: string): string { return `atelier-${id}`; }

function workspacePublishHost(): string { return "127.0.0.1"; }
async function configuredWorkspaceCgroupParent(): Promise<string | undefined> {
  const inspected = await runDocker(["inspect", "--format", `{{index .Config.Labels "${workspaceCgroupParentLabel}"}}`, hostname()]);
  if (inspected.exitCode !== 0) return undefined;
  const parent = inspected.stdout.trim();
  return parent && parent !== "<no value>" ? parent : undefined;
}
function formatDeleteBlockedMessage(id: string, issues: JsonObject[]): string { return `workspace ${id} has delete blockers:\n${issues.map((issue) => `- ${JSON.stringify(issue)}`).join("\n")}\nuse --force to delete anyway`; }
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

async function inspectWorkspaceContainerImage(id: string): Promise<string> {
  await resolveWorkspace(id);
  const inspected = await runDocker(["inspect", "--format", "{{.Image}}", workspaceContainerName(id)]);
  if (inspected.exitCode !== 0) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
  return inspected.stdout.trim();
}

async function waitForWorkspaceStartup(id: string): Promise<string> {
  const timeoutSeconds = Math.ceil(workspaceStartupTimeoutMs / 1000);
  const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `deadline=$(( $(date +%s) + ${timeoutSeconds} )); while [ "$(date +%s)" -le "$deadline" ]; do if test -f /.atelier/ready; then cat /.atelier/startup.log; exit 0; fi; sleep 0.05; done; tail -n 120 /.atelier/startup.log; exit 1`]);
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
  docker?: { privileged?: boolean; preloadImages?: string[] };
  initScripts?: string[];
  seedPiConfig?: {
    authJson?: string;
    modelsJson?: string;
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
  if (record.isAtelier !== undefined) throw invalidArguments(`invalid ${path}: isAtelier is no longer supported; use docker.preloadImages`);
  const dockerRecord = optionalRecord(record, "docker", path);
  const privileged = dockerRecord ? optionalBoolean(dockerRecord, "privileged", path, "docker.privileged") : undefined;
  const preloadImagesValue = dockerRecord?.preloadImages;
  if (preloadImagesValue !== undefined && !Value.Check(nonBlankStringArraySchema, preloadImagesValue)) {
    throw invalidArguments(`invalid ${path}: docker.preloadImages must be an array of non-empty strings`);
  }
  const preloadImages = preloadImagesValue?.map((spec) => spec.trim());
  if (preloadImages && preloadImages.length > 0 && privileged !== true) throw invalidArguments(`invalid ${path}: docker.preloadImages requires docker.privileged to be true`);
  const docker: RepoWorkspaceManifest["docker"] | undefined = dockerRecord ? {} : undefined;
  if (docker && privileged !== undefined) docker.privileged = privileged;
  if (docker && preloadImages) docker.preloadImages = preloadImages;
  const initScripts = record.initScripts;
  if (initScripts !== undefined && !Value.Check(stringArraySchema, initScripts)) throw invalidArguments(`invalid ${path}: initScripts must be an array of strings`);
  const seedPiConfigRecord = optionalRecord(record, "seedPiConfig", path);
  const authJson = seedPiConfigRecord ? optionalString(seedPiConfigRecord, "authJson", path, "seedPiConfig.authJson") : undefined;
  const modelsJson = seedPiConfigRecord ? optionalString(seedPiConfigRecord, "modelsJson", path, "seedPiConfig.modelsJson") : undefined;
  const seedAtelierConfigRecord = optionalRecord(record, "seedAtelierConfig", path);
  const projectsJson = seedAtelierConfigRecord ? optionalString(seedAtelierConfigRecord, "projectsJson", path, "seedAtelierConfig.projectsJson") : undefined;
  const manifest: RepoWorkspaceManifest = { version: 1 };
  if (docker) manifest.docker = docker;
  if (initScripts) manifest.initScripts = initScripts;
  if (seedPiConfigRecord) {
    manifest.seedPiConfig = {};
    if (authJson) manifest.seedPiConfig.authJson = authJson;
    if (modelsJson) manifest.seedPiConfig.modelsJson = modelsJson;
  }
  if (seedAtelierConfigRecord) {
    manifest.seedAtelierConfig = {};
    if (projectsJson) manifest.seedAtelierConfig.projectsJson = projectsJson;
  }
  return manifest;
}

function applySeedConfigManifest(manifest: RepoWorkspaceManifest, plan: WorkspaceDockerPlan): void {
  const runtime = getAtelierRuntimeContext();
  const entries = [
    manifest.seedPiConfig?.authJson ? { source: atelierDataPath(runtime, "pi-config", "auth.json"), staging: "/tmp/atelier-seed-pi-auth.json", target: manifest.seedPiConfig.authJson } : undefined,
    manifest.seedPiConfig?.modelsJson ? { source: atelierDataPath(runtime, "pi-config", "models.json"), staging: "/tmp/atelier-seed-pi-models.json", target: manifest.seedPiConfig.modelsJson } : undefined,
    manifest.seedAtelierConfig?.projectsJson ? { source: atelierDataPath(runtime, "projects.json"), staging: "/tmp/atelier-seed-projects.json", target: manifest.seedAtelierConfig.projectsJson } : undefined,
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
  if (manifest.docker?.preloadImages?.length) plan.preloadDockerImages = [...new Set(manifest.docker.preloadImages)];
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
const workspaceSetupStep = "workspace.setup";

export async function runWorkspaceSetupScript(id: string, options: { events?: AtelierEventBus } = {}): Promise<boolean> {
  if (!(await Bun.file(join(workspaceWorkHostPath(id), workspaceSetupScript)).exists())) {
    await options.events?.emit("workspace_provision_step", { workspaceId: id, id: workspaceSetupStep, detail: `No ${workspaceSetupScript}` });
    return false;
  }

  const session = `atelier-provision-setup-${crypto.randomUUID().slice(0, 8)}`;
  const dockerCommand = ["docker", ...workspaceExecDockerArgs(id, ["sh", workspaceSetupScript], {}, true)].map(shellQuote).join(" ");
  const result = await runHostObservableCommand({
    session,
    cwd: "/",
    command: dockerCommand,
    onSessionStarted: async () => {
      await options.events?.emit("workspace_provision_step", { workspaceId: id, id: workspaceSetupStep, terminal: { kind: "host-tmux", session } });
    },
  });
  const output = tailTerminalText(stripTerminalControls(result.output));
  if (result.exitCode !== 0) throw new AtelierCoreError("workspace_setup_failed", output || `${workspaceSetupScript} failed with exit code ${result.exitCode}`);
  await options.events?.emit("workspace_provision_step", { workspaceId: id, id: workspaceSetupStep, output });
  return true;
}

export const workspaceSetupProvisioningHook: WorkspaceServerProvisioningHook = {
  id: workspaceSetupStep,
  label: "Run project setup",
  onFailure: "await-continue",
  async run({ workspaceId, creationContext, events }) {
    if (creationContext?.fork) {
      await events?.emit("workspace_provision_step", { workspaceId, id: workspaceSetupStep, detail: "Skipped for copied workspace" });
      return;
    }
    await runWorkspaceSetupScript(workspaceId, { events });
  },
};

function dockerMountArg(mount: WorkspaceDockerMount): string {
  return [`type=${mount.type}`, ...(mount.source === undefined ? [] : [`src=${mount.source}`]), `dst=${mount.target}`, ...(mount.readonly ? ["readonly"] : [])].join(",");
}

function planEnvDockerArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
}

function workspaceCreateDockerArgs(container: string, image: string, publishHost: string, gatewayHostPort: number, plan: WorkspaceDockerPlan): string[] {
  return [
    "create",
    "--init",
    "--restart", "unless-stopped",
    "--name", container,
    ...Object.entries(plan.labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]),
    ...plan.publishes.flatMap((port) => ["--publish", `${publishHost}:${port === workspaceGatewayPort ? gatewayHostPort : ""}:${port}`]),
    ...planEnvDockerArgs(plan.env),
    ...plan.extraArgs,
    ...plan.mounts.flatMap((mount) => ["--mount", dockerMountArg(mount)]),
    "--user", "root",
    image,
    ...(plan.sharedDocker ? ["bash", "/usr/local/bin/atelier-workspace-docker"] : []),
    "sh", "-lc", workspaceInitScript(plan),
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
  return { labels, env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...hostUserEnv() }, mounts: [], publishes: [workspaceGatewayPort], extraArgs: ["--privileged"], initScripts: [workspaceGitCredentialInitScript()], containerFiles: [], cleanup: [] };
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
    "exec /usr/local/bin/atelier-workspace-gateway",
  ].join("\n");
}

export async function createWorkspace(options: CreateWorkspaceOptions = {}): Promise<WorkspaceNewResult> {
  const id = options.id ?? generateWorkspaceId();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw invalidArguments(`invalid workspace id: ${id}`);
  if (await isRetiredWorkspaceId(id)) throw invalidArguments(`workspace id has been permanently retired and cannot be reused: ${id}`);
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
    await writeWorkspaceInit(getAtelierRuntimeContext(), id, init);
    if (!fork) {
      await provisionStep(options.events, id, "workspace.source", "Prepare workspace source", async () => {
        await options.events?.emit("workspace_source_prepare", { workspaceId: id, init, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot });
      });
    }
    const labels = { [workspaceTypeLabel]: "workspace", [namespaceLabel]: namespace(), [workspaceIdLabel]: id } satisfies Record<string, string>;
    plan = baseWorkspacePlan(labels);
    const gatewayTokenPath = atelierDataPath(getAtelierRuntimeContext(), "workspaces", id, "gateway-token");
    await writeFile(gatewayTokenPath, crypto.randomUUID() + crypto.randomUUID(), { mode: 0o600 });
    plan.containerFiles.push({ source: gatewayTokenPath, target: "/etc/atelier-workspace-gateway-token" });
    const cgroupParent = await configuredWorkspaceCgroupParent();
    if (cgroupParent) plan.extraArgs.push("--cgroup-parent", cgroupParent);
    plan.mounts.push({ type: "bind", source: source.dockerHostWorktreePath, target: workspaceRoot });
    const activePlan = plan;
    await provisionStep(options.events, id, "workspace.plan", "Prepare workspace container plan", async () => {
      await applyRepoWorkspaceManifest(source.worktreePath, activePlan);
      await options.events?.emit("workspace_plan_prepare", { workspaceId: id, init, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot, plan: activePlan });
    });
    const sharedConnection = await readDockerRuntimeConnection();
    if (sharedConnection) {
      await provisionStep(options.events, id, "workspace.docker-runtime", "Register private Docker runtime", () => registerWorkspaceDocker(activePlan, atelierDataPath(getAtelierRuntimeContext(), "workspaces", id, "docker-runtime"), sharedConnection));
    }
    const carrierPlatform = !activePlan.sharedDocker && activePlan.preloadDockerImages?.length ? await nativeLinuxDockerPlatform() : undefined;
    let imageResolution: WorkspaceImageResolution | undefined;
    if (!activePlan.image && !forkImage) {
      const configuration: WorkspaceImageConfigureEvent = { init };
      await options.events?.emit("workspace_image_configure", configuration);
      imageResolution = await provisionStep(options.events, id, "workspace.image", "Resolve workspace image", () => resolveWorkspaceImageResolution({ workspaceId: id, events: options.events, sourcePath: source.worktreePath, dockerfile: configuration.dockerfile }));
      activePlan.image = imageResolution.image;
    } else {
      activePlan.image ??= forkImage;
      if (forkImage && carrierPlatform) imageResolution = { image: forkImage, defaultImage: await ensureDefaultWorkspaceImage() };
    }
    if (activePlan.sharedDocker) {
      await prepareSharedDocker(activePlan, atelierDataPath(getAtelierRuntimeContext(), "workspaces", id, "docker-runtime"));
    } else {
      activePlan.initScripts.push(nestedDockerDaemonInitScript());
    }
    if (activePlan.sharedDocker && activePlan.preloadDockerImages?.length) {
      const resolution = imageResolution ?? { image: activePlan.image!, defaultImage: activePlan.preloadDockerImages.includes("default-atelier-workspace-image") ? await ensureDefaultWorkspaceImage() : activePlan.image! };
      const preload = await provisionStep(options.events, id, "workspace.docker-images", "Resolve Docker image prewarming", () => resolveDockerImagePreload({ specs: activePlan.preloadDockerImages!, workspaceResolution: resolution, events: options.events, workspaceId: id }));
      if (sharedConnection?.buildServices) {
        const sharedPreload = await provisionStep(options.events, id, "workspace.docker-publish", "Publish Docker preloads", () => prepareSharedImagePreload(sharedConnection, preload));
        activePlan.initScripts.unshift(...sharedPreload);
      } else {
        activePlan.initScripts.unshift(...preload.images.map((image) => [`docker pull ${shellQuote(image.sourceRef)}`, ...image.aliases.map((alias) => `docker tag ${shellQuote(image.sourceRef)} ${shellQuote(alias)}`)].join("\n")));
      }
    }
    if (activePlan.preloadDockerImages?.length && imageResolution && carrierPlatform) {
      const preload = await provisionStep(options.events, id, "workspace.docker-images", "Resolve nested Docker images", () => resolveDockerImagePreload({ specs: activePlan.preloadDockerImages!, workspaceResolution: imageResolution, events: options.events, workspaceId: id }), { output: (result) => result.images.map((image) => `${image.sourceRef} ${image.imageId}${image.aliases.length ? `\n  aliases: ${image.aliases.join(", ")}` : ""}`).join("\n") });
      let carrierProgress = "";
      const carrier = await provisionStep(options.events, id, "workspace.image-carrier", "Prepare preloaded workspace image", () => prepareWorkspaceImageCarrier({
        resolution: imageResolution,
        platform: carrierPlatform,
        preload,
        events: options.events,
        workspaceId: id,
        onProgress: async (message) => {
          carrierProgress += `${message}\n`;
          await options.events?.emit("workspace_provision_step", { workspaceId: id, id: "workspace.image-carrier", output: carrierProgress });
        },
      }), { output: (result) => [`Path: ${result.path}`, `Carrier key: ${result.key}`].join("\n") });
      activePlan.image = carrier.image;
      activePlan.initScripts.push(...carrier.initScripts);
    }
    await provisionStep(options.events, id, "workspace.container", "Start workspace container", async () => {
      const image = activePlan.image;
      if (!image) throw new AtelierCoreError("workspace_image_missing", "workspace image was not resolved");
      const publishHost = workspacePublishHost();
      const container = workspaceContainerName(id);
      // Pin the allocated host port in Docker's configuration. Docker's ::port
      // shorthand reallocates it on automatic restart, invalidating ingress's
      // cached endpoint. Hold the host port until immediately before Docker binds.
      const reservation = Bun.listen({ hostname: publishHost, port: 0, socket: { data(socket) { socket.end(); } } });
      try {
        await requireDocker(workspaceCreateDockerArgs(container, image, publishHost, reservation.port, activePlan));
        for (const file of activePlan.containerFiles) await requireDocker(["cp", file.source, `${container}:${file.target}`]);
      } finally {
        reservation.stop(true);
      }
      await requireDocker(["start", container]);
    });
    await provisionStep(options.events, id, "workspace.startup", "Wait for workspace startup", () => waitForWorkspaceStartup(id), { output: (log) => log });
  } catch (error) {
    try {
      const removed = await runDocker(["rm", "-f", "--volumes", workspaceContainerName(id)]);
      if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) throw new Error(removed.stderr.trim() || "could not remove failed workspace container");
      await retireWorkspaceDocker(atelierDataPath(getAtelierRuntimeContext(), "workspaces", id, "docker-runtime"));
      await Promise.all((plan?.cleanup ?? []).map((cleanup) => cleanup()));
      await deleteWorkspaceWorkDir(id);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `workspace ${id} provisioning and cleanup failed; ownership records retained`);
    }
    throw error;
  }
  return { id };
}

const workspaceGatewayCache = new Map<string, Promise<WorkspaceGateway>>();

function workspaceGatewayCacheKey(id: string): string {
  return `${namespace()}\0${id}`;
}

async function inspectWorkspaceGateway(id: string): Promise<WorkspaceGateway> {
  await resolveWorkspace(id);
  const result = await runDocker(["port", workspaceContainerName(id), `${workspaceGatewayPort}/tcp`]);
  if (result.exitCode !== 0) throw new AtelierCoreError("workspace_gateway_unavailable", `Workspace ${id} has no published gateway. Recreate workspaces made with an older image. ${result.stderr.trim()}`);
  const line = result.stdout.trim().split(/\n+/)[0] ?? "";
  const match = line.match(/^127\.0\.0\.1:(\d+)$/);
  if (!match) throw new AtelierCoreError("workspace_gateway_unavailable", `Invalid workspace gateway binding: ${line}`);
  const token = await readFile(atelierDataPath(getAtelierRuntimeContext(), "workspaces", id, "gateway-token"), "utf8");
  return { url: new URL(`http://127.0.0.1:${match[1]}`), token };
}

async function workspaceGateway(id: string): Promise<WorkspaceGateway> {
  const key = workspaceGatewayCacheKey(id);
  let gateway = workspaceGatewayCache.get(key);
  if (!gateway) {
    gateway = inspectWorkspaceGateway(id).catch((error) => {
      workspaceGatewayCache.delete(key);
      throw error;
    });
    workspaceGatewayCache.set(key, gateway);
  }
  return await gateway;
}

/** Resolve any workspace-local web app through the one published gateway. */
export async function workspacePortBackend(id: string, port: number, pathAndSearch: string, protocol = "http:"): Promise<WorkspaceHttpAppBackend> {
  if (!isWorkspaceAppPort(port)) throw invalidArguments(`Invalid workspace app port ${port}: use 1–65535, except reserved gateway port ${workspaceGatewayPort}`);
  if (protocol !== "http:" && protocol !== "https:") throw invalidArguments("Workspace apps must use HTTP or HTTPS");
  const path = pathAndSearch.startsWith("/") ? pathAndSearch : `/${pathAndSearch}`;
  // Concatenation, not URL resolution: // in an app path must never change hosts.
  const target = new URL(`${protocol}//127.0.0.1:${port}${path}`);
  return { kind: "http", target, gateway: await workspaceGateway(id) };
}

async function currentWorkspaceImageId(sourcePath: string, dockerfile?: string): Promise<string | undefined> {
  return await inspectWorkspaceImage({ sourcePath, dockerfile, preloadImages: await readDockerRuntimeConnection() ? undefined : (await readRepoWorkspaceManifest(sourcePath))?.docker?.preloadImages });
}

export async function workspaceImageOutdated(id: string, container = workspaceContainerName(id), events?: AtelierEventBus): Promise<boolean> {
  const configuration: WorkspaceImageConfigureEvent = { init: await readWorkspaceInit(getAtelierRuntimeContext(), id) };
  await events?.emit("workspace_image_configure", configuration);
  const [expectedImageId, actualImage] = await Promise.all([
    currentWorkspaceImageId(workspaceWorkHostPath(id), configuration.dockerfile),
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
  if (containerExists) await requireDocker(["rm", "-f", "--volumes", workspaceContainerName(id)]);
  await retireWorkspaceDocker(atelierDataPath(getAtelierRuntimeContext(), "workspaces", id, "docker-runtime"));
  await retireWorkspaceId(id);
  workspaceGatewayCache.delete(workspaceGatewayCacheKey(id));
  await options.events?.emit("workspace_deleted", { workspaceId: id });
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
  await requireDocker(running ? ["start", name] : ["stop", "--time", "0", name]);
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
