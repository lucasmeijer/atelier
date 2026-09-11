import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceDockerPlan } from "./types.ts";

const restart = `Restart=on-failure
RestartSec=2s`;
const limits = `StartLimitIntervalSec=60s
StartLimitBurst=5`;
const environment = "EnvironmentFile=/.atelier/environment";

export function workspaceSystemdUnits(shared: boolean) {
  const units = {
    "atelier-init.service": `[Unit]
Description=Atelier workspace initialization
Before=atelier-gateway.service

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
Requires=docker.socket
After=docker.socket${shared ? " atelier-containerd.service" : ""}
${shared ? "Wants=atelier-containerd.service\n" : ""}${limits}

[Service]
Type=notify
${environment}
ExecStart=/usr/bin/dockerd ${shared ? "--config-file=/.atelier/docker-daemon.json" : "-H fd:// --live-restore --tls=false --storage-driver=fuse-overlayfs --max-concurrent-uploads=1"}
${restart}
TimeoutStartSec=90s
TimeoutStopSec=120s
Delegate=yes
KillMode=process
TasksMax=infinity
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
`,
  };
  if (shared) return {
    ...units,
    "atelier-snapshotter.service": `[Unit]
Description=Atelier local snapshotter adapter
${limits}

[Service]
ExecStart=/usr/local/bin/atelier-workspace-start-snapshotter
${restart}
Delegate=yes
TasksMax=infinity
`,
    "atelier-containerd.service": `[Unit]
Description=Atelier private containerd
Wants=atelier-snapshotter.service
After=atelier-snapshotter.service
${limits}

[Service]
Type=notify
ExecStart=/usr/bin/containerd --config /.atelier/containerd.toml
${restart}
Delegate=yes
KillMode=process
TasksMax=infinity
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
`,
  };
  return units;
}

export async function prepareWorkspaceSystemd(plan: WorkspaceDockerPlan, directory: string, init: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const files = { "init.sh": init, ...workspaceSystemdUnits(!!plan.sharedDocker) };
  for (const [name, content] of Object.entries(files)) {
    const source = join(directory, name);
    await writeFile(source, content);
    plan.containerFiles.push({ source, target: name === "init.sh" ? "/.atelier/init.sh" : `/etc/systemd/system/${name}` });
  }
  if (!plan.extraArgs.includes("--privileged")) plan.extraArgs.push("--privileged");
  plan.extraArgs.push("--cgroupns=private", "--tmpfs", "/run", "--tmpfs", "/run/lock", "--stop-signal", "SIGRTMIN+3");
}
