const listenHost = "127.0.0.1";
const listenPort = 58124;
export const workspaceLocalProxyUrl = `http://${listenHost}:${listenPort}`;
const logPath = "/.atelier/egress-proxy.log";

export function workspaceLocalProxyInitScript(): string {
  return `nohup node /usr/local/lib/atelier-egress-proxy.mjs > ${logPath} 2>&1 < /dev/null &
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
