const listenHost = "127.0.0.1";
const listenPort = 58124;
export const workspaceLocalProxyUrl = `http://${listenHost}:${listenPort}`;
const logPath = "/.atelier/egress-proxy.log";

// Each accepted connection opens the current socket inode, so app replacement
// needs no workspace relay restart. Only active connections need child processes.
export function workspaceLocalProxyInitScript(): string {
  return `nohup socat TCP4-LISTEN:${listenPort},bind=${listenHost},reuseaddr,fork UNIX-CONNECT:/run/atelier-parent/egress.sock > ${logPath} 2>&1 < /dev/null &
proxy_pid=$!
proxy_listening() { ss -H -ltnp 'sport = :${listenPort}' | grep -Fq "pid=$proxy_pid,"; }
for _ in $(seq 1 100); do
  if ! kill -0 "$proxy_pid" 2>/dev/null || proxy_listening; then break; fi
  sleep .1
done
if ! kill -0 "$proxy_pid" 2>/dev/null || ! proxy_listening; then
  cat ${logPath} >&2
  echo 'Workspace egress forwarder did not start' >&2
  exit 1
fi`;
}
