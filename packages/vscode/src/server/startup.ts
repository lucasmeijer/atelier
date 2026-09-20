import { shellQuote } from "@atelier/core";
import { workspaceRoot, workspaceVSCodePort } from "@atelier/workspace";

/** Even on its dedicated port, VS Code must not adopt or stop an unrelated listener. */
export function vscodeStartupScript(workspaceFile: string): string {
  return `
    set -eu
    mkdir -p /.atelier/vscode/workspaces
    exec 9>/.atelier/vscode/start.lock
    flock -x 9
    ready_url='http://127.0.0.1:${workspaceVSCodePort}/'

    conflict() {
      echo "VS Code cannot start: workspace port ${workspaceVSCodePort} is occupied by another service (or its ownership cannot be verified). The service has not been stopped. Move your app to another port, or stop it yourself, then retry VS Code. Inspect with: ss -ltnp 'sport = :${workspaceVSCodePort}'" >&2
      exit 1
    }

    # HTTP success and process-name matches alone do not establish port ownership.
    # Check every listener, including IPv6 and listeners whose PID is hidden.
    listener_is_owned() {
      listeners="$(ss -H -ltnp 'sport = :${workspaceVSCodePort}')" || exit 1
      if [ -z "$listeners" ]; then return 1; fi
      printf '%s\n' "$listeners" | while IFS= read -r listener; do
        pids="$(printf '%s\n' "$listener" | grep -o 'pid=[0-9]*' | cut -d= -f2)"
        [ -n "$pids" ] || exit 2
        for pid in $pids; do
          [ "$(readlink /proc/$pid/exe)" = /opt/atelier/vscode-server/node ] || exit 2
          tr '\\000' '\\n' < /proc/$pid/cmdline | grep -Fxq /opt/atelier/vscode-server/out/server-main.js || exit 2
        done
      done || conflict
    }

    is_ready() {
      listener_is_owned || return 1
      curl --noproxy '*' -fsS --max-time 2 "$ready_url" >/dev/null 2>&1 || return 1
      # Recheck ownership after the HTTP request too.
      listener_is_owned
    }

    # An owned listener may still be booting. Start only when the port is free.
    if ! listener_is_owned; then
      printf '%s\n' '${JSON.stringify({ folders: [{ path: workspaceRoot }] })}' > ${shellQuote(workspaceFile)}
      ATELIER_VSCODE_HOST=0.0.0.0 ATELIER_VSCODE_PORT=${workspaceVSCodePort} ATELIER_VSCODE_DEFAULT_WORKSPACE=${shellQuote(workspaceFile)} nohup atelier-start-vscode > /.atelier/vscode/server.log 2>&1 9>&- &
      started_pid=$!
    fi

    for _ in $(seq 1 120); do
      if is_ready; then exit 0; fi
      if [ -n "\${started_pid:-}" ] && ! kill -0 "$started_pid" 2>/dev/null; then
        echo "VS Code server exited during startup. See /.atelier/vscode/server.log" >&2
        tail -n 80 /.atelier/vscode/server.log >&2
        exit 1
      fi
      sleep 0.5
    done
    echo "VS Code server did not become ready at $ready_url. See /.atelier/vscode/server.log" >&2
    exit 1
  `;
}
