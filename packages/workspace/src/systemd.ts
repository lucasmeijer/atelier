import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registryLoopbackAddress } from "@atelier/workspace-image";
import { privateDockerRoot, type SharedDockerRuntime } from "./shared-docker.ts";
import type { WorkspaceDockerPlan } from "./types.ts";

const restart = `Restart=on-failure
RestartSec=2s`;
const limits = `StartLimitIntervalSec=60s
StartLimitBurst=5`;
const environment = "EnvironmentFile=/.atelier/environment";

const containerRuntime = `Delegate=yes
KillMode=process
TasksMax=infinity
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity`;

function systemdArgument(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

interface WorkspaceSystemdUnits { [unitName: string]: string }

export function workspaceSystemdUnits(runtime?: SharedDockerRuntime): WorkspaceSystemdUnits {
  const registrySocket = runtime?.registrySocket;
  const dependencies: string[] = [];
  if (runtime) dependencies.push("atelier-containerd.service");
  if (registrySocket) dependencies.push("atelier-registry.service");
  const units: WorkspaceSystemdUnits = {
    "atelier-init.service": `[Unit]
Description=Atelier workspace initialization

[Service]
Type=oneshot
${environment}
WorkingDirectory=/work
ExecStart=/bin/sh /.atelier/init.sh
RemainAfterExit=yes
TimeoutStartSec=infinity
`,
    "atelier-gateway.service": `[Unit]
Description=Atelier workspace gateway
Requires=atelier-init.service
After=atelier-init.service
${limits}

[Service]
${environment}
WorkingDirectory=/work
ExecStart=/usr/local/bin/atelier-workspace-gateway
ExecStopPost=/usr/bin/rm -f /.atelier/ready
${restart}
KillMode=mixed
TimeoutStopSec=30s

[Install]
WantedBy=multi-user.target
`,
    "docker.socket": `[Unit]
Description=Atelier Docker API socket

[Socket]
ListenStream=/run/docker.sock
SocketMode=0660
SocketUser=root
SocketGroup=docker
RemoveOnStop=yes

[Install]
WantedBy=sockets.target
`,
    "docker.service": `[Unit]
Description=Atelier workspace Docker daemon
Requires=docker.socket${registrySocket ? " atelier-registry.socket" : ""}
After=${["docker.socket", ...dependencies].join(" ")}
Wants=${dependencies.join(" ")}
${limits}

[Service]
Type=notify
${environment}
ExecStart=/usr/bin/dockerd -H fd:// --live-restore ${runtime ? "--config-file=/.atelier/docker-daemon.json" : "--tls=false --storage-driver=fuse-overlayfs --max-concurrent-uploads=1"}
${restart}
TimeoutStartSec=90s
TimeoutStopSec=120s
${containerRuntime}
`,
  };
  if (registrySocket) {
    units["atelier-registry.socket"] = `[Unit]
Description=Atelier local registry socket

[Socket]
ListenStream=${registryLoopbackAddress}

[Install]
WantedBy=sockets.target
`;
    units["atelier-registry.service"] = `[Unit]
Description=Atelier registry TCP to Unix relay
Requires=atelier-registry.socket
After=atelier-registry.socket
${limits}

[Service]
Type=exec
ExecStart=:/usr/lib/systemd/systemd-socket-proxyd ${systemdArgument(registrySocket)}
${restart}
`;
  }

  if (runtime) {
    units["atelier-snapshotter.service"] = `[Unit]
Description=Atelier local snapshotter adapter
${limits}

[Service]
ExecStartPre=/usr/bin/mkdir -p /run/containerd
ExecStart=:/usr/local/bin/atelier-workspace-snapshotter --local-socket /run/containerd/atelier-snapshotter.sock --local-root ${privateDockerRoot}/snapshots --shared-socket ${systemdArgument(runtime.snapshotterSocket)}
${restart}
Delegate=yes
TasksMax=infinity
`;
    units["atelier-containerd.service"] = `[Unit]
Description=Atelier private containerd
Wants=atelier-snapshotter.service
After=atelier-snapshotter.service
${limits}

[Service]
Type=notify
ExecStart=/usr/bin/containerd --config /.atelier/containerd.toml
${restart}
${containerRuntime}
`;
  }
  return units;
}

export async function prepareWorkspaceSystemd(plan: WorkspaceDockerPlan, directory: string, init: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const files = { "init.sh": init, ...workspaceSystemdUnits(plan.sharedDocker) };
  for (const [name, content] of Object.entries(files)) {
    const source = join(directory, name);
    await writeFile(source, content);
    plan.containerFiles.push({ source, target: name === "init.sh" ? "/.atelier/init.sh" : `/etc/systemd/system/${name}` });
  }
  if (!plan.extraArgs.includes("--privileged")) plan.extraArgs.push("--privileged");
  plan.extraArgs.push("--cgroupns=private", "--tmpfs", "/run", "--stop-signal", "SIGRTMIN+3");
}
