import { requireDocker, runDocker } from "./docker.ts";
import { CliError, invalidArguments, writeSuccess } from "./json.ts";

const workspaceTypeLabel = "com.atelier.type";
const namespaceLabel = "com.atelier.namespace";
const titlePath = "/.atelier/title";

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

function namespace(): string {
  return process.env.ATELIER_NAMESPACE || "default";
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw invalidArguments(`missing ${name}`);
  return value;
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
    "ubuntu:24.04",
    "sh",
    "-lc",
    "useradd --create-home --shell /bin/bash atelier && mkdir -p /.atelier && sleep infinity",
  ]);

  const id = created.stdout.trim();
  await requireDocker(["rename", id, `atelier-${id}`]);

  writeSuccess({ id });
}

async function workspaceList(args: string[]): Promise<void> {
  if (args.length !== 0) throw invalidArguments("workspace list takes no arguments");

  const listed = await requireDocker([
    "ps",
    "-aq",
    "--no-trunc",
    "--filter",
    `label=${workspaceTypeLabel}=workspace`,
    "--filter",
    `label=${namespaceLabel}=${namespace()}`,
  ]);

  const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
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
  const result = await runDocker(["exec", "--user", "atelier", id, ...command]);
  const durationMs = Math.round(performance.now() - started);

  const execResult: WorkspaceExecResult = {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs,
  };
  writeSuccess(execResult);
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
      throw invalidArguments(`unknown workspace command: ${subcommand ?? ""}`);
  }
}
