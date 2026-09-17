/** Installed in the workspace image; provisioning and standalone tests share these. */
export function workspaceRuntimeUnits() {
  return {
    "atelier-tmux.service": `[Unit]
Description=Atelier workspace terminal workloads
[Service]
Type=exec
User=atelier
EnvironmentFile=/.atelier/environment
WorkingDirectory=/work
# -D keeps the server in the foreground and disables exit-empty. Use the
# default socket so ordinary tmux commands share this managed server.
ExecStart=/usr/bin/tmux -D
# Do not release initialization until the server accepts commands. -N forbids
# a readiness probe from accidentally starting another server.
ExecStartPost=/bin/sh -ec 'until /usr/bin/tmux -N show-options -g >/dev/null 2>&1; do sleep 0.05; done'
TimeoutStartSec=10s
CPUWeight=10
Nice=10
OOMScoreAdjust=500
# An individual workload OOM must not cause systemd to kill every terminal.
OOMPolicy=continue
Restart=always
RestartSec=1s
TimeoutStopSec=10s
`,
    "atelier-init.service": `[Unit]
Description=Atelier workspace initialization
[Service]
Type=oneshot
EnvironmentFile=/.atelier/environment
WorkingDirectory=/work
ExecStart=/bin/sh /.atelier/init.sh
RemainAfterExit=yes
TimeoutStartSec=infinity
`,
    "atelier-gateway.service": `[Unit]
Description=Atelier workspace gateway
Requires=atelier-init.service
After=atelier-init.service
StartLimitIntervalSec=60s
StartLimitBurst=5
[Service]
EnvironmentFile=/.atelier/environment
WorkingDirectory=/work
ExecStart=/usr/local/bin/atelier-workspace-gateway
ExecStopPost=/usr/bin/rm -f /.atelier/ready
Restart=on-failure
RestartSec=2s
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
Requires=docker.socket containerd.service
After=docker.socket containerd.service
StartLimitIntervalSec=60s
StartLimitBurst=5
[Service]
Type=notify
# System services do not inherit the workspace shell's proxy environment.
EnvironmentFile=/.atelier/environment
ExecStart=/usr/local/bin/dockerd --live-restore
Restart=on-failure
RestartSec=2s
TimeoutStartSec=90s
TimeoutStopSec=120s
Delegate=yes
KillMode=process
TasksMax=infinity
LimitNOFILE=infinity
`,
    "containerd.service": `[Unit]
Description=Atelier workspace containerd
[Service]
Type=notify
ExecStart=/usr/local/bin/containerd --config /etc/containerd/config.toml
Restart=on-failure
RestartSec=2s
Delegate=yes
KillMode=process
TasksMax=infinity
LimitNOFILE=infinity
`,
  };
}
