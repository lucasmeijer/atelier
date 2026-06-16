import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { AtelierCoreError, atelierDataPath, dockerHostAtelierDataPath, getAtelierRuntimeContext, invalidArguments, requireDocker, runDocker, type AtelierEventBus, type WorkspaceDockerMount, type WorkspaceDockerPlan } from "@atelier/core";
import { resolveWorkspaceImage } from "@atelier/workspace-image";

const workspaceTypeLabel = "com.atelier.type";
const namespaceLabel = "com.atelier.namespace";
const workspaceIdLabel = "com.atelier.workspace-id";
const titlePath = "/.atelier/title";
export const workspaceRoot = "/work";
export const workspaceVSCodePort = 8000;
export const workspacePreviewPorts = [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010] as const;
export const workspaceSourceRepositoryLabel = "com.atelier.source-repo";

export interface WorkspaceNewResult { id: string }
export interface WorkspaceListResult { workspaces: Array<{ id: string; title: string | null; sourceRepositoryId?: string | null }> }
export interface WorkspaceExecResult { exitCode: number; stdout: string; stderr: string; durationMs: number }
export interface WorkspaceCommandOptions { workdir?: string; user?: "atelier" | "root"; stdin?: string }
export interface WorkspaceCommandContext { events?: AtelierEventBus }
export interface DeleteWorkspaceOptions { force?: boolean; events?: AtelierEventBus }
export interface CreateWorkspaceOptions { id?: string; events?: AtelierEventBus; sourceRepositoryId?: string; context?: Record<string, unknown> }

function namespace(): string { return process.env.ATELIER_NAMESPACE || "default"; }
export function generateWorkspaceId(): string { return crypto.randomUUID().replaceAll("-", "").slice(0, 8); }
export function workspaceContainerName(id: string): string { return `atelier-${id}`; }
function workspacePublishHost(): string { return process.env.ATELIER_WORKSPACE_PUBLISH_HOST || "127.0.0.1"; }
function workspaceDockerNetwork(): string | undefined { return process.env.ATELIER_WORKSPACE_DOCKER_NETWORK || undefined; }
function formatDeleteBlockedMessage(id: string, issues: unknown[]): string { return `workspace ${id} has delete blockers:\n${issues.map((issue) => `- ${JSON.stringify(issue)}`).join("\n")}\nuse --force to delete anyway`; }
function dockerHostGatewayArgs(): string[] { return ["--add-host", "host.docker.internal:host-gateway"]; }
function requireArg(value: string | undefined, name: string): string { if (!value) throw invalidArguments(`missing ${name}`); return value; }
function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
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
  const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `mkdir -p ${shellQuote(workspaceRoot)} /.atelier && chown -R atelier:atelier ${shellQuote(workspaceRoot)} /.atelier`]);
  if (result.exitCode !== 0) throw new AtelierCoreError("workspace_repair_failed", result.stderr.trim() || result.stdout.trim() || `could not prepare workspace filesystem for ${id}`);
}

async function waitForWorkspaceStartup(id: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await runDocker(["exec", "--user", "root", workspaceContainerName(id), "sh", "-lc", `test -d ${shellQuote(workspaceRoot)}`]);
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

async function readTitle(containerRef: string): Promise<string | null> {
  const result = await runDocker(["exec", containerRef, "cat", titlePath]);
  if (result.exitCode !== 0) return null;
  return result.stdout.replace(/\n$/, "");
}

export async function execWorkspaceCommand(id: string, command: string[], options: WorkspaceCommandOptions = {}): Promise<WorkspaceExecResult> {
  if (command.length === 0) throw invalidArguments("command is required");
  const resolved = await resolveWorkspace(id);
  const startedAt = Date.now();
  const result = await runDocker(["exec", ...(options.stdin !== undefined ? ["-i"] : []), "--user", options.user ?? "atelier", "--env", "LANG=C.UTF-8", "--env", "LC_ALL=C.UTF-8", "--workdir", options.workdir ?? workspaceRoot, workspaceContainerName(resolved), ...command], { stdin: options.stdin });
  return { ...result, durationMs: Date.now() - startedAt };
}
export async function execWorkspaceShell(id: string, script: string, options: WorkspaceCommandOptions = {}): Promise<WorkspaceExecResult> { return await execWorkspaceCommand(id, ["sh", "-lc", script], options); }
export async function execWorkspace(id: string, command: string[]): Promise<WorkspaceExecResult> { if (command.length === 0) throw invalidArguments("workspace exec requires a command"); return await execWorkspaceCommand(id, command); }

function dockerMountArg(mount: WorkspaceDockerMount): string { return [`type=${mount.type}`, `src=${mount.source}`, `dst=${mount.target}`, ...(mount.readonly ? ["readonly"] : [])].join(","); }
function planEnvDockerArgs(env: Record<string, string>): string[] { return Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]); }
function baseWorkspacePlan(labels: Record<string, string>): WorkspaceDockerPlan {
  const network = workspaceDockerNetwork();
  return { labels, env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, mounts: [], publishes: [workspaceVSCodePort, ...workspacePreviewPorts], extraArgs: [...(network ? ["--network", network] : []), ...dockerHostGatewayArgs()], initScripts: [], cleanup: [] };
}
function workspaceInitScript(plan: WorkspaceDockerPlan): string {
  return [`mkdir -p /.atelier ${workspaceRoot}`, `chown -R atelier:atelier /.atelier ${workspaceRoot}`, ...plan.initScripts, `if command -v atelier-start-vscode >/dev/null 2>&1; then su atelier -c 'ATELIER_VSCODE_DEFAULT_FOLDER=${workspaceRoot} nohup atelier-start-vscode > /.atelier/vscode-server.log 2>&1 &' || true; elif command -v code >/dev/null 2>&1; then su atelier -c 'nohup code serve-web --accept-server-license-terms --host 0.0.0.0 --port ${workspaceVSCodePort} --without-connection-token --default-folder ${workspaceRoot} > /.atelier/vscode-server.log 2>&1 &' || true; fi`, "sleep infinity"].join("; ");
}

export async function createWorkspace(options: CreateWorkspaceOptions = {}): Promise<WorkspaceNewResult> {
  const id = options.id ?? generateWorkspaceId();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw invalidArguments(`invalid workspace id: ${id}`);
  const context = options.context && Object.keys(options.context).length ? options.context : undefined;
  const source = await createWorkspaceWorkDir(id);
  let plan: WorkspaceDockerPlan | undefined;
  try {
    await options.events?.emit("workspace_source_prepare", { workspaceId: id, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot });
    const labels: Record<string, string> = { [workspaceTypeLabel]: "workspace", [namespaceLabel]: namespace(), [workspaceIdLabel]: id };
    if (options.sourceRepositoryId) labels[workspaceSourceRepositoryLabel] = options.sourceRepositoryId;
    plan = baseWorkspacePlan(labels);
    plan.mounts.push({ type: "bind", source: source.dockerHostWorktreePath, target: workspaceRoot });
    plan.initScripts.push("git config --file /home/atelier/.gitconfig user.name 'Lucas Meijer'; git config --file /home/atelier/.gitconfig user.email lucas@lucasmeijer.com; chown atelier:atelier /home/atelier/.gitconfig");
    await options.events?.emit("workspace_plan_prepare", { workspaceId: id, context, workHostPath: source.worktreePath, workContainerPath: workspaceRoot, plan });
    plan.image ??= await resolveWorkspaceImage({ workspaceId: id, events: options.events, sourcePath: source.worktreePath });
    await requireDocker(["run", "-d", "--name", workspaceContainerName(id), ...Object.entries(plan.labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]), ...plan.publishes.flatMap((port) => ["--publish", `${workspacePublishHost()}::${port}`]), ...planEnvDockerArgs(plan.env), ...plan.extraArgs, ...plan.mounts.flatMap((mount) => ["--mount", dockerMountArg(mount)]), "--user", "root", plan.image, "sh", "-lc", workspaceInitScript(plan)]);
    await waitForWorkspaceStartup(id);
    await resolveWorkspace(id);
  } catch (error) {
    await runDocker(["rm", "-f", workspaceContainerName(id)]).catch(() => undefined);
    await Promise.all((plan?.cleanup ?? []).map((cleanup) => Promise.resolve(cleanup()).catch(() => undefined)));
    await deleteWorkspaceWorkDir(id).catch(() => undefined);
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
export async function getWorkspaceVSCodePort(id: string): Promise<number> { return await getWorkspacePublishedPort(id, workspaceVSCodePort); }
export async function getWorkspacePreviewPort(id: string, containerPort: number): Promise<number> { if (!(workspacePreviewPorts as readonly number[]).includes(containerPort)) throw invalidArguments(`unsupported workspace preview port: ${containerPort}. Supported ports: ${workspacePreviewPorts.join(", ")}`); return await getWorkspacePublishedPort(id, containerPort); }

export async function listWorkspaces(): Promise<WorkspaceListResult> {
  const listed = await requireDocker(["ps", "-a", "--filter", `label=${workspaceTypeLabel}=workspace`, "--filter", `label=${namespaceLabel}=${namespace()}`, "--format", `{{.ID}}\t{{.Label "${workspaceIdLabel}"}}\t{{.Label "${workspaceSourceRepositoryLabel}"}}`]);
  const workspaces: WorkspaceListResult["workspaces"] = [];
  for (const line of listed.stdout.trim().split(/\n+/).filter(Boolean)) {
    const [containerId, labelledId, sourceRepositoryId] = line.split("\t");
    if (!containerId) continue;
    const id = labelledId?.trim() || containerId.slice(0, 8);
    const source = sourceRepositoryId?.trim();
    workspaces.push({ id, title: await readTitle(containerId), ...(source ? { sourceRepositoryId: source } : {}) });
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
  await requireDocker(["exec", "-i", workspaceContainerName(id), "sh", "-c", `mkdir -p /.atelier && cat > ${titlePath}`], { stdin: title });
  return null;
}

export async function workspaceCommand(args: string[], context: WorkspaceCommandContext = {}): Promise<unknown> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "new": {
      if (rest.length > 1) throw invalidArguments("usage: atelier workspace new [git-url]");
      const creationContext = rest[0] ? { gitUrl: rest[0] } : undefined;
      const created = await createWorkspace({ events: context.events, context: creationContext });
      await context.events?.emit("workspace_created", { workspaceId: created.id, context: creationContext });
      return created;
    }
    case "list": if (rest.length !== 0) throw invalidArguments("workspace list takes no arguments"); return await listWorkspaces();
    case "delete": {
      const force = rest.includes("--force");
      const ids = rest.filter((arg) => arg !== "--force");
      const id = requireArg(ids[0], "workspace id");
      if (ids.length !== 1) throw invalidArguments("usage: atelier workspace delete [--force] <workspace-id>");
      return await deleteWorkspace(id, { force, events: context.events });
    }
    case "title": return await setWorkspaceTitle(requireArg(rest[0], "workspace id"), rest.slice(1).join(" "));
    case "exec": {
      const id = requireArg(rest[0], "workspace id");
      const separatorIndex = rest.indexOf("--");
      if (separatorIndex !== 1) throw invalidArguments("usage: atelier workspace exec <workspace-id> -- <command...>");
      return await execWorkspace(id, rest.slice(separatorIndex + 1));
    }
    default: throw invalidArguments(`unknown workspace command: ${subcommand ?? ""}`);
  }
}
