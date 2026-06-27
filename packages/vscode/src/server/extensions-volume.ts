import { requireDocker, runDocker, shellQuote, type AtelierEventBus } from "@atelier/core";
import { runHostObservableCommand } from "@atelier/observable-terminal/server";

const extensionIds = ["ms-vscode.cpptools-extension-pack", "ms-dotnettools.csdevkit"] as const;
const extensionSetVersion = "2026-06-17.2";
const extensionsMountPath = "/opt/atelier/vscode-extensions";
const seedImage = "mcr.microsoft.com/devcontainers/base:ubuntu-24.04";

const ensureTasks = new Map<string, Promise<string>>();

function slug(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
}

function namespace(): string {
  return process.env.ATELIER_NAMESPACE || "host";
}

function workspaceExtensionsVolumeName(workspaceId: string, arch: string): string {
  return `atelier-vscode-extensions-${slug(namespace())}-${slug(workspaceId)}-${arch}-${slug(extensionSetVersion)}`;
}

async function dockerArchitecture(): Promise<string> {
  const result = await requireDocker(["info", "--format", "{{.Architecture}}"]);
  return slug(result.stdout.trim() || "unknown");
}

function codeAptSetupScript(): string {
  return `
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gpg
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /etc/apt/keyrings/packages.microsoft.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list
apt-get update
apt-get install -y --no-install-recommends code
`;
}

function waitForVSCodeServerScript(logPath: string): string {
  return `
for i in $(seq 1 120); do
  body="$(curl -fsS http://127.0.0.1:8000/ 2>/dev/null || true)"
  echo "$body" | grep -qi "workbench" && break
  sleep 1
  if [ "$i" = 120 ]; then
    cat ${logPath}
    echo "VS Code extension volume seed timed out" >&2
    exit 1
  fi
done
`;
}

function seedScript(): string {
  const installExtensions = extensionIds.map((id) => `su atelier -c '/home/atelier/.vscode/cli/serve-web/*/bin/code-server --extensions-dir /extensions --install-extension ${id} --force'`).join("\n");
  const verifyExtensions = extensionIds.map((id) => `grep -x '${id}@.*' /tmp/vscode-extensions.log`).join("\n");
  return `
set -eux
export DEBIAN_FRONTEND=noninteractive
${codeAptSetupScript()}
id -u atelier >/dev/null 2>&1 || useradd --create-home --shell /bin/bash atelier
install -d -o atelier -g atelier /extensions /home/atelier/.vscode-server
su atelier -c 'nohup code serve-web --accept-server-license-terms --host 127.0.0.1 --port 8000 --without-connection-token --server-data-dir /home/atelier/.vscode-server > /tmp/vscode-extension-seed.log 2>&1 &'
${waitForVSCodeServerScript("/tmp/vscode-extension-seed.log")}
pkill -u atelier -f 'code serve-web|code-server' || true
${installExtensions}
su atelier -c '/home/atelier/.vscode/cli/serve-web/*/bin/code-server --extensions-dir /extensions --list-extensions --show-versions' | tee /tmp/vscode-extensions.log
${verifyExtensions}
chmod -R a+rX /extensions
find /extensions -type d -exec chmod 0755 {} +
find /extensions -type f -exec sh -c 'for file do magic="$(head -c 4 "$file" | od -An -tx1 | tr -d " ")"; first2="$(head -c 2 "$file")"; if [ "$magic" = "7f454c46" ] || [ "$first2" = "#!" ]; then chmod 0755 "$file"; fi; done' sh {} +
`;
}

async function volumeExists(volume: string): Promise<boolean> {
  const inspected = await runDocker(["volume", "inspect", volume]);
  return inspected.exitCode === 0;
}

async function ensureVSCodeExtensionsVolumeForArch(arch: string, options: { events?: AtelierEventBus; workspaceId?: string } = {}): Promise<string> {
  const volume = `atelier-vscode-extensions-${arch}-${slug(extensionSetVersion)}`;
  if (await volumeExists(volume)) return volume;

  await requireDocker(["volume", "create", "--label", "com.atelier.type=vscode-extensions", "--label", `com.atelier.version=${extensionSetVersion}`, volume]);
  const args = [
    "run",
    "--rm",
    "--mount",
    `type=volume,src=${volume},dst=/extensions`,
    seedImage,
    "sh",
    "-lc",
    seedScript(),
  ];
  const seeded = await runHostObservableCommand({
    session: `atelier-provision-vscode-${crypto.randomUUID().slice(0, 8)}`,
    cwd: process.cwd(),
    command: `docker ${args.map(shellQuote).join(" ")}`,
    onSessionStarted: async (session) => {
      if (options.events && options.workspaceId) await options.events.emit("workspace_provision_step", { workspaceId: options.workspaceId, id: "vscode.extensions", label: "Prepare VS Code extensions", parentId: "workspace.plan", status: "running", terminal: { kind: "host-tmux", session } });
    },
  });
  if (seeded.exitCode !== 0) {
    await runDocker(["volume", "rm", "-f", volume]).catch(() => undefined);
    const output = seeded.output.trim();
    throw new Error(output || `could not seed VS Code extensions volume ${volume}`);
  }
  return volume;
}

async function ensureSharedVSCodeExtensionsVolume(options: { events?: AtelierEventBus; workspaceId?: string } = {}): Promise<{ arch: string; volume: string }> {
  const arch = await dockerArchitecture();
  let task = ensureTasks.get(arch);
  if (!task) {
    task = ensureVSCodeExtensionsVolumeForArch(arch, options).catch((error) => {
      ensureTasks.delete(arch);
      throw error;
    });
    ensureTasks.set(arch, task);
  }
  return { arch, volume: await task };
}

async function copyVSCodeExtensionsVolume(source: string, target: string): Promise<void> {
  const args = [
    "run",
    "--rm",
    "--mount",
    `type=volume,src=${source},dst=/source,readonly`,
    "--mount",
    `type=volume,src=${target},dst=/target`,
    seedImage,
    "sh",
    "-lc",
    "rm -rf /target/* /target/.[!.]* /target/..?*; cp -a /source/. /target/",
  ];
  await requireDocker(args);
}

async function ensureWorkspaceVSCodeExtensionsVolume(workspaceId: string, options: { events?: AtelierEventBus } = {}): Promise<string> {
  const shared = await ensureSharedVSCodeExtensionsVolume({ events: options.events, workspaceId });
  const volume = workspaceExtensionsVolumeName(workspaceId, shared.arch);
  if (await volumeExists(volume)) return volume;
  await requireDocker([
    "volume", "create",
    "--label", "com.atelier.type=vscode-extensions-workspace",
    "--label", `com.atelier.namespace=${namespace()}`,
    "--label", `com.atelier.workspace-id=${workspaceId}`,
    "--label", `com.atelier.version=${extensionSetVersion}`,
    volume,
  ]);
  try {
    await copyVSCodeExtensionsVolume(shared.volume, volume);
  } catch (error) {
    await runDocker(["volume", "rm", "-f", volume]).catch(() => undefined);
    throw error;
  }
  return volume;
}

async function deleteWorkspaceVSCodeExtensionsVolume(volume: string): Promise<void> {
  await runDocker(["volume", "rm", "-f", volume]);
}

export function registerVSCodeEvents(events: AtelierEventBus): void {
  events.on("workspace_plan_prepare", async ({ workspaceId, plan }) => {
    const source = await ensureWorkspaceVSCodeExtensionsVolume(workspaceId, { events });
    await events.emit("workspace_provision_step", { workspaceId, id: "vscode.extensions", label: "Prepare VS Code extensions", parentId: "workspace.plan", status: "done" });
    plan.mounts.push({ type: "volume", source, target: extensionsMountPath });
    plan.initScripts.push(`chown -R atelier:atelier ${extensionsMountPath}`);
    plan.cleanup.push(() => deleteWorkspaceVSCodeExtensionsVolume(source));
  });
  events.on("workspace_deleted", async ({ workspaceId }) => {
    const arch = await dockerArchitecture();
    await deleteWorkspaceVSCodeExtensionsVolume(workspaceExtensionsVolumeName(workspaceId, arch));
  });
}
