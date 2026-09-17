import { runDocker } from "@atelier/core";

// inotify instances are shared by host UID, including the root processes in
// every workspace. Set the host minimum through Docker, also on Docker Desktop.
export const inotifyMinimumScript = `set -eu
file="$1"
current=$(cat "$file")
if [ "$current" -lt 8192 ]; then
  printf '8192\\n' > "$file"
fi
actual=$(cat "$file")
if [ "$actual" -lt 8192 ]; then
  echo "inotify limit is still $actual; expected at least 8192" >&2
  exit 1
fi
printf 'fs.inotify.max_user_instances=%s\\n' "$actual"
`;

export async function ensureHostInotifyLimit(image: string, docker = runDocker): Promise<void> {
  const result = await docker([
    "run", "--rm", "--pull=never", "--privileged", "--network=none",
    "--user", "root", "--entrypoint", "/bin/sh", image,
    "-c", inotifyMinimumScript, "atelier-inotify", "/proc/sys/fs/inotify/max_user_instances",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`Cannot prepare the Docker host for workspace file watchers. Allow privileged helper containers, or set fs.inotify.max_user_instances to at least 8192 on the Docker host, then restart Atelier.\n${result.stderr.trim() || result.stdout.trim()}`);
  }
  console.log(`[workspaces] ${result.stdout.trim()}`);
}
