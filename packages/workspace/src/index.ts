import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AtelierCoreError, atelierDataPath, dockerHostAtelierDataPath, getAtelierRuntimeContext, invalidArguments, requireDocker, runDocker, shellQuote, type AtelierEventBus } from "@atelier/core";
import { resolveWorkspaceImage } from "@atelier/workspace-image";
import type { WorkspaceCreationContext, WorkspaceDockerMount, WorkspaceDockerPlan } from "./types.ts";
export type { WorkspaceCreationContext, WorkspaceDockerMount, WorkspaceDockerPlan } from "./types.ts";

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
const titlePath = "title";
const parkedPath = "parked";
export const workspaceRoot = "/work";
export const workspaceVSCodePort = 8000;
export const workspaceDesktopPort = 6080;
export const workspacePreviewPorts = [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010] as const;
export const workspaceSourceRepositoryLabel = "com.atelier.source-repo";
export const workspaceSourceRepositoryNameLabel = "com.atelier.source-repo-name";

export interface WorkspaceNewResult { id: string }
export interface WorkspaceListResult { workspaces: Array<{ id: string; title: string | null; parked?: boolean; sourceRepositoryId?: string | null; sourceRepositoryName?: string | null }> }
export interface WorkspaceExecResult { exitCode: number; stdout: string; stderr: string; durationMs: number }
export interface WorkspaceCommandOptions { workdir?: string; user?: "atelier" | "root"; stdin?: string }
export interface DeleteWorkspaceOptions { force?: boolean; events?: AtelierEventBus }
export interface CreateWorkspaceOptions { id?: string; events?: AtelierEventBus; sourceRepositoryId?: string; sourceRepositoryName?: string; context?: WorkspaceCreationContext }

function namespace(): string { return process.env.ATELIER_NAMESPACE || "default"; }
export function generateWorkspaceId(): string { return crypto.randomUUID().replaceAll("-", "").slice(0, 8); }
export function workspaceContainerName(id: string): string { return `atelier-${id}`; }
async function workspacePublishHost(): Promise<string> {
  return (await getAtelierRuntimeContext()).workspacePortHostFromAtelier;
}
function formatDeleteBlockedMessage(id: string, issues: unknown[]): string { return `workspace ${id} has delete blockers:\n${issues.map((issue) => `- ${JSON.stringify(issue)}`).join("\n")}\nuse --force to delete anyway`; }
function dockerHostGatewayArgs(): string[] { return ["--add-host", "host.docker.internal:host-gateway"]; }
async function provisionStep<T>(events: AtelierEventBus | undefined, workspaceId: string, id: string, label: string, fn: () => Promise<T>, options: { parentId?: string } = {}): Promise<T> {
  await events?.emit("workspace_provision_step", { workspaceId, id, label, status: "running", parentId: options.parentId });
  try {
    const result = await fn();
    await events?.emit("workspace_provision_step", { workspaceId, id, label, status: "done", parentId: options.parentId });
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

async function waitForWorkspaceStartup(id: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", "test -f /.atelier/ready"]);
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new AtelierCoreError("workspace_startup_timeout", `workspace did not finish startup: ${id}`);
}

export async function resolveWorkspace(id: string): Promise<string> {
  const labels = await inspectLabels(id);
  if (labels[workspaceTypeLabel] !== "workspace" || labels[namespaceLabel] !== namespace()) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
  await ensureWorkspaceFilesystem(id);
  return id;
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

export async function execWorkspaceCommand(id: string, command: string[], options: WorkspaceCommandOptions = {}): Promise<WorkspaceExecResult> {
  if (command.length === 0) throw invalidArguments("command is required");
  const resolved = await resolveWorkspace(id);
  const startedAt = Date.now();
  const result = await runDocker(["exec", ...(options.stdin !== undefined ? ["-i"] : []), "--user", options.user ?? "atelier", "--env", "LANG=C.UTF-8", "--env", "LC_ALL=C.UTF-8", "--workdir", options.workdir ?? workspaceRoot, workspaceContainerName(resolved), ...command], { stdin: options.stdin });
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
  return { ATELIER_HOST_UID: String(process.getuid()), ATELIER_HOST_GID: String(process.getgid()) };
}

function baseWorkspacePlan(labels: Record<string, string>): WorkspaceDockerPlan {
  return { labels, env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...hostUserEnv() }, mounts: [], publishes: [workspaceVSCodePort, workspaceDesktopPort, ...workspacePreviewPorts], extraArgs: [...dockerHostGatewayArgs()], initScripts: [workspaceGitCredentialInitScript()], cleanup: [] };
}

interface WorkspaceRuntimeManifest {
  privileged?: boolean;
  initScripts?: string[];
}

async function readWorkspaceRuntimeManifest(workHostPath: string): Promise<WorkspaceRuntimeManifest | undefined> {
  for (const path of [join(workHostPath, "workspace.json"), join(workHostPath, ".atelier", "workspace-image.json")]) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    const manifest = JSON.parse(await file.text()) as WorkspaceRuntimeManifest & { version?: number };
    if (manifest.version !== undefined && manifest.version !== 1) throw new Error(`unsupported workspace manifest version: ${manifest.version}`);
    return manifest;
  }
  return undefined;
}

function applyWorkspaceRuntimeManifest(plan: WorkspaceDockerPlan, manifest: WorkspaceRuntimeManifest | undefined): void {
  if (!manifest) return;
  if (manifest.privileged) plan.extraArgs.push("--privileged");
  if (manifest.initScripts) {
    if (!Array.isArray(manifest.initScripts) || manifest.initScripts.some((script) => typeof script !== "string")) throw new Error("workspace manifest initScripts must be an array of strings");
    plan.initScripts.push(...manifest.initScripts);
  }
}
function alignWorkspaceUserScript(): string {
  return `work_uid="\${ATELIER_HOST_UID:?}"
work_gid="\${ATELIER_HOST_GID:?}"
if [ "$work_uid" = 0 ] || [ "$work_gid" = 0 ]; then echo "Atelier must run as a non-root host user" >&2; exit 1; fi
conflict_user="$(getent passwd "$work_uid" | cut -d: -f1 || true)"
if [ -n "$conflict_user" ] && [ "$conflict_user" != atelier ]; then userdel "$conflict_user"; fi
if [ "$(id -g atelier)" != "$work_gid" ]; then groupmod -o -g "$work_gid" atelier; fi
if [ "$(id -u atelier)" != "$work_uid" ] || [ "$(id -g atelier)" != "$work_gid" ]; then usermod -u "$work_uid" -g "$work_gid" atelier; fi`;
}

function workspaceInitScript(plan: WorkspaceDockerPlan): string {
  return [alignWorkspaceUserScript(), `install -d -o atelier -g atelier /.atelier`, ...plan.initScripts, `if command -v atelier-start-vscode >/dev/null 2>&1; then su atelier -c 'ATELIER_VSCODE_DEFAULT_FOLDER=${workspaceRoot} nohup atelier-start-vscode > /.atelier/vscode-server.log 2>&1 &' || true; elif command -v code >/dev/null 2>&1; then su atelier -c 'nohup code serve-web --accept-server-license-terms --host 0.0.0.0 --port ${workspaceVSCodePort} --without-connection-token --default-folder ${workspaceRoot} > /.atelier/vscode-server.log 2>&1 &' || true; fi`, "touch /.atelier/ready", "sleep infinity"].join("; ");
}

export async function createWorkspace(options: CreateWorkspaceOptions = {}): Promise<WorkspaceNewResult> {
  const id = options.id ?? generateWorkspaceId();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw invalidArguments(`invalid workspace id: ${id}`);
  const context = options.context && Object.keys(options.context).length ? options.context : undefined;
  const source = await provisionStep(options.events, id, "workspace.workdir", "Create workspace directory", () => createWorkspaceWorkDir(id));
  let plan: WorkspaceDockerPlan | undefined;
  try {
    await provisionStep(options.events, id, "workspace.source", "Prepare workspace source", async () => {
      await options.events?.emit("workspace_source_prepare", { workspaceId: id, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot });
    });
    const labels: Record<string, string> = { [workspaceTypeLabel]: "workspace", [namespaceLabel]: namespace(), [workspaceIdLabel]: id };
    if (options.sourceRepositoryId) labels[workspaceSourceRepositoryLabel] = options.sourceRepositoryId;
    if (options.sourceRepositoryName) labels[workspaceSourceRepositoryNameLabel] = options.sourceRepositoryName;
    plan = baseWorkspacePlan(labels);
    applyWorkspaceRuntimeManifest(plan, await readWorkspaceRuntimeManifest(source.worktreePath));
    plan.mounts.push({ type: "bind", source: source.dockerHostWorktreePath, target: workspaceRoot });
    const activePlan = plan;
    await provisionStep(options.events, id, "workspace.plan", "Prepare workspace container plan", async () => {
      await options.events?.emit("workspace_plan_prepare", { workspaceId: id, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot, plan: activePlan });
    });
    activePlan.image ??= await provisionStep(options.events, id, "workspace.image", "Build workspace image", () => resolveWorkspaceImage({ workspaceId: id, events: options.events, sourcePath: source.worktreePath }));
    await provisionStep(options.events, id, "workspace.container", "Start workspace container", async () => {
      const image = activePlan.image;
      if (!image) throw new AtelierCoreError("workspace_image_missing", "workspace image was not resolved");
      const publishHost = await workspacePublishHost();
      await requireDocker(["run", "-d", "--name", workspaceContainerName(id), ...Object.entries(activePlan.labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]), ...activePlan.publishes.flatMap((port) => ["--publish", `${publishHost}::${port}`]), ...planEnvDockerArgs(activePlan.env), ...activePlan.extraArgs, ...activePlan.mounts.flatMap((mount) => ["--mount", dockerMountArg(mount)]), "--user", "root", image, "sh", "-lc", workspaceInitScript(activePlan)]);
    });
    await provisionStep(options.events, id, "workspace.startup", "Wait for workspace startup", () => waitForWorkspaceStartup(id));
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

async function workspacePublishedEndpoint(id: string, containerPort: number): Promise<WorkspacePublishedEndpoint> {
  await resolveWorkspace(id);
  const result = await runDocker(["port", workspaceContainerName(id), `${containerPort}/tcp`]);
  if (result.exitCode !== 0) throw new AtelierCoreError("workspace_port_not_found", result.stderr.trim() || `workspace ${id} does not publish port ${containerPort}`);
  const line = result.stdout.trim().split(/\n+/)[0] ?? "";
  const match = line.match(/^\[([^\]]+)\]:(\d+)$/) ?? line.match(/^(.+):(\d+)$/);
  if (!match) throw new AtelierCoreError("workspace_port_not_found", `could not parse published port for ${id}:${containerPort}: ${line}`);
  return { host: match[1]!, port: Number(match[2]!) };
}

async function reachableWorkspacePublishedEndpoint(id: string, containerPort: number): Promise<WorkspacePublishedEndpoint> {
  const endpoint = await workspacePublishedEndpoint(id, containerPort);
  const runtime = await getAtelierRuntimeContext();
  return { host: runtime.workspacePortHostFromAtelier, port: endpoint.port };
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
  const listed = await requireDocker(["ps", "-a", "--filter", `label=${workspaceTypeLabel}=workspace`, "--filter", `label=${namespaceLabel}=${namespace()}`, "--format", `{{.ID}}\t{{.Label "${workspaceIdLabel}"}}\t{{.Label "${workspaceSourceRepositoryLabel}"}}\t{{.Label "${workspaceSourceRepositoryNameLabel}"}}`]);
  const workspaces: WorkspaceListResult["workspaces"] = [];
  for (const line of listed.stdout.trim().split(/\n+/).filter(Boolean)) {
    const [containerId, labelledId, sourceRepositoryId, sourceRepositoryName] = line.split("\t");
    if (!containerId) continue;
    const id = labelledId?.trim() || containerId.slice(0, 8);
    const source = sourceRepositoryId?.trim();
    const sourceName = sourceRepositoryName?.trim();
    const parked = await readParked(context, id);
    workspaces.push({ id, title: await readTitle(context, id), ...(parked ? { parked } : {}), ...(source ? { sourceRepositoryId: source } : {}), ...(sourceName ? { sourceRepositoryName: sourceName } : {}) });
  }
  return { workspaces };
}

export async function deleteWorkspace(id: string, options: DeleteWorkspaceOptions = {}): Promise<null> {
  await resolveWorkspace(id);
  if (!options.force) {
    const issues: unknown[] = [];
    await options.events?.emit("workspace_delete_inspect", { workspaceId: id, issues });
    if (issues.length > 0) throw new AtelierCoreError("workspace_delete_blocked", formatDeleteBlockedMessage(id, issues), { workspaceId: id, issues });
  }
  await requireDocker(["rm", "-f", workspaceContainerName(id)]);
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

