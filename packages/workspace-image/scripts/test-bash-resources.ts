// bun packages/workspace-image/scripts/test-bash-resources.ts <local-workspace-image>
// Tests current source in a disposable, memory-limited Linux container.
import assert from "node:assert/strict";
import { workspaceRuntimeUnits } from "../src/workspace-systemd-units.ts";

const image = process.argv[2];
if (!image || process.argv.length !== 3) throw new Error("Pass a local workspace image containing systemd, sudo, tmux and Python");
const name = `atelier-bash-resources-${crypto.randomUUID()}`;
async function docker(args: string[], input?: string, check = true) {
  const child = Bun.spawn(["docker", ...args], { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (check) assert.equal(code, 0, `${args.join(" ")}\n${stdout}\n${stderr}`);
  return { stdout, stderr, code };
}
async function exec(...args: string[]) { return (await docker(["exec", name, ...args])).stdout.trim(); }
try {
  await docker(["run", "-d", "--name", name, "--privileged", "--cgroupns=private", "--memory=512m", "--memory-swap=512m", "--tmpfs", "/run", "--entrypoint", "/sbin/init", image]);
  for (let attempt = 0; ; attempt++) {
    const ready = await docker(["exec", name, "systemctl", "show", "--property=Version"], undefined, false);
    if (ready.code === 0) break;
    assert.ok(attempt < 100, `systemd did not start: ${ready.stderr}`);
    await Bun.sleep(100);
  }
  await docker(["cp", new URL("../rootfs/usr/local/bin/atelier-bash-command", import.meta.url).pathname, `${name}:/usr/local/bin/atelier-bash-command`]);
  await docker(["exec", "-i", name, "tee", "/etc/systemd/system/atelierbash.slice"], workspaceRuntimeUnits()["atelierbash.slice"]);
  await exec("systemctl", "daemon-reload");
  await exec("systemd-run", "--unit=resource-test-gateway", "/bin/sleep", "infinity");
  const uid = await exec("id", "-u", "atelier");
  const result = await docker(["exec", "--user", "atelier", "--workdir", "/work", name,
    "env", "PATH=/work/custom-bin:/usr/local/bin:/usr/bin:/bin", "/usr/local/bin/atelier-bash-command", "bash", "-c", `
      test "$(id -u)" = ${uid} && test "$HOME" = /home/atelier && test "$PWD" = /work || exit 90
      test "$PATH" = /work/custom-bin:/usr/local/bin:/usr/bin:/bin || exit 91
      test "$(cat /proc/self/oom_score_adj)" = 500 || exit 92
      test "$(ps -o ni= -p $$ | tr -d ' ')" = 10 || exit 93
      group=$(sed -n 's/^0:://p' /proc/self/cgroup)
      test "$(cat /sys/fs/cgroup$group/memory.oom.group)" = 1 || exit 94
      case "$group" in /atelierbash.slice/atelier-bash-*.scope) ;; *) exit 95;; esac
      exit 17
    `], undefined, false);
  assert.equal(result.code, 17, JSON.stringify(result));
  assert.equal(await exec("cat", "/sys/fs/cgroup/atelierbash.slice/cpu.weight"), "10");

  // A tmux pane owns the PTY and completion reporting outside the expendable scope.
  const command = `/usr/local/bin/atelier-bash-command python3 -c 'import os, subprocess
assert os.isatty(0)
child=subprocess.Popen(["sleep", "infinity"])
open("/tmp/command-child", "w").write(str(child.pid))
a=[]
while True: a.append(bytearray(8*1024*1024))'
printf '%s' "$?" > /tmp/command-exit`;
  await docker(["exec", "-i", name, "tee", "/tmp/resource-command.sh"], command);
  await docker(["exec", "--user", "atelier", name, "tmux", "new-session", "-d", "-s", "resource-test", "bash /tmp/resource-command.sh"]);
  let code = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    const probe = await docker(["exec", name, "cat", "/tmp/command-exit"], undefined, false);
    if (probe.code === 0) { code = probe.stdout; break; }
    await Bun.sleep(100);
  }
  assert.equal(code, "137", "OOM must finish the Bash call without killing its completion reporter");
  assert.match(await exec("cat", "/sys/fs/cgroup/memory.events"), /oom_group_kill [1-9]/);
  assert.equal(await exec("systemctl", "is-active", "resource-test-gateway"), "active");
  const child = await exec("cat", "/tmp/command-child");
  const alive = await docker(["exec", name, "test", "-e", `/proc/${child}`], undefined, false);
  assert.notEqual(alive.code, 0, "OOM must kill the command's background children too");
  console.log("PASS: identity/environment/exit status preserved; low CPU weight and nice priority; command-tree OOM; PTY and completion reporter survive; gateway survives");
} finally {
  await docker(["rm", "-f", name]);
}
