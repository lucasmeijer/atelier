import { shellQuote } from "@atelier/core";

export function nestedDockerDaemonInitScript(): string {
  const logPath = "/.atelier/dockerd.log";
  return `mkdir -p /.atelier /var/lib/docker
if ! docker info >/dev/null 2>&1; then
  docker_pid=
  if [ -f /var/run/docker.pid ]; then
    docker_pid="$(cat /var/run/docker.pid)" || { echo "could not read nested Docker PID file" >&2; exit 1; }
  fi
  case "$docker_pid" in
    ''|*[!0-9]*) docker_pid= ;;
    *)
      if ! kill -0 "$docker_pid" 2>/dev/null || [ "$(cat "/proc/$docker_pid/comm" 2>/dev/null)" != dockerd ]; then docker_pid=; fi
      ;;
  esac
  if [ -z "$docker_pid" ]; then
    rm -f /var/run/docker.pid /var/run/docker.sock
    containerd_pid_file=/var/run/docker/containerd/containerd.pid
    if [ -f "$containerd_pid_file" ]; then
      containerd_pid="$(cat "$containerd_pid_file")" || { echo "could not read nested containerd PID file" >&2; exit 1; }
      case "$containerd_pid" in
        ''|*[!0-9]*) rm -f "$containerd_pid_file" ;;
        *)
          if ! kill -0 "$containerd_pid" 2>/dev/null || [ "$(cat "/proc/$containerd_pid/comm" 2>/dev/null)" != containerd ]; then rm -f "$containerd_pid_file"; fi
          ;;
      esac
    fi
    nohup dockerd -H unix:///var/run/docker.sock --tls=false --storage-driver=fuse-overlayfs --max-concurrent-uploads=1 > ${shellQuote(logPath)} 2>&1 &
  fi
fi
for i in $(seq 1 300); do docker info >/dev/null 2>&1 && break; sleep .1; done
if ! docker info >/dev/null 2>&1; then tail -n 120 ${shellQuote(logPath)} >&2; exit 1; fi
storage_driver="$(docker info --format '{{.Driver}}')"
[ "$storage_driver" = fuse-overlayfs ] || { echo "unexpected nested Docker storage driver: $storage_driver" >&2; exit 1; }`;
}
