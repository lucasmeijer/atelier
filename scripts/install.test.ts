import { expect, test } from "bun:test";

const installer = await Bun.file(new URL("./install.sh", import.meta.url)).text();

function run(options: { systemState?: "restarting" | "exited"; nonRoot?: boolean; denySudo?: boolean; mac?: boolean; wsl?: boolean; installed?: boolean; old?: boolean; pullFails?: boolean; appFails?: boolean; pendingHealth?: boolean; missingFilesystem?: boolean; loadable?: boolean } = {}, args: string[] = []) {
  const logPath = `/tmp/atelier-install-test-${crypto.randomUUID()}.log`;
  const mock = `
mktemp() { echo "${logPath}"; }
sleep() { command sleep 0.01; }
uname() { echo ${options.mac ? "Darwin" : "Linux"}; }
id() { echo ${options.mac || options.nonRoot ? 501 : 0}; }
sudo() {
  printf 'SUDO %s\\n' "$*" >&2
  if [ "$1" = -v ]; then return ${options.denySudo ? 1 : 0}; fi
  "$@"
}
module_loaded=0
grep() { if [[ "$*" == *microsoft* ]]; then return ${options.wsl ? 0 : 1}; fi; [ "$module_loaded" -eq 1 ] || return ${options.missingFilesystem ? 1 : 0}; }
modprobe() {
  printf 'MODPROBE %s\\n' "$*" >&2
  module_loaded=1
  return ${options.missingFilesystem && !options.loadable ? 1 : 0};
}
mkdir() { :; }
docker() {
  printf 'DOCKER %s\\n' "$*" >&2
  case "$1 \${2:-}" in
    'container inspect')
      case "$3" in
        atelier-system) return ${options.installed ? 0 : 1} ;;
        atelier) return ${options.old ? 0 : 1} ;;
      esac ;;
    'pull '*) return ${options.pullFails ? 1 : 0} ;;
    'exec atelier-system')
      if [[ "$*" == *3001/status* ]]; then
        if [ "${options.pendingHealth ? 1 : 0}" -eq 1 ] && [ ! -e "${logPath}.checked" ]; then
          touch "${logPath}.checked"
          printf 'starting\\nAn activity the installer has never heard of\\n42\\n'
          return
        fi
        printf '${options.appFails ? 'failed\\nApp health failed\\n\\n\\n\\n\\nApp exited' : 'ready\\nAtelier is ready\\n\\nhttps://app.example/custom-path\\n\\n\\n'}\\n'
        return
      fi ;;
    'logs --tail') echo 'supervisor startup failed: io.weight unavailable';;
    'inspect --format') if [[ "$*" == *State.Status* ]]; then echo ${options.systemState ?? 'running'}; elif [[ "$*" == *3080/tcp* ]]; then echo 55123; else echo true; fi ;;
  esac
}
`;
  const script = installer
    .replace("tee /etc/modules-load.d/atelier-system.conf", "tee /dev/null")
    // Mock terminal availability and answers; these tests exercise Docker orchestration.
    .replace("{ [ -t 0 ]; } 2>/dev/null </dev/tty", "true")
    .replace(
      'IFS= read -r -t 10 "$1" </dev/tty',
      `if [ "$1" = action ]; then action=update; else answer=${options.installed ? "yes" : "1"}; fi`,
    );
  const result = Bun.spawnSync([process.platform === "darwin" ? "/bin/bash" : "bash", "-c", mock + script, "installer", ...args], { stdin: "ignore" });
  const log = Bun.spawnSync(["cat", logPath]).stdout.toString();
  Bun.spawnSync(["rm", "-f", logPath, `${logPath}.checked`]);
  return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() + log };
}

test("fresh install launches privileged System with persistent named volume and bootstrap app", () => {
  const result = run({}, ["--system-image", "test/system:v1", "--app-image", "test/app:v1"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER pull test/system:v1");
  expect(result.output).toContain("--name atelier-system --hostname atelier-system --privileged --cgroupns=host --restart unless-stopped --stop-timeout 120 --tmpfs /run --mount source=atelier-system,target=/data --publish 127.0.0.1::3080 test/system:v1 --app-image test/app:v1 --access-mode tailscale");
  expect(result.output).not.toContain("DOCKER stop");
  expect(result.output).toContain("DOCKER exec atelier-system bun -e");
});

test("replacement downloads before stopping and retains volume", () => {
  const result = run({ installed: true });
  expect(result.status).toBe(0);
  const commands = result.output;
  expect(commands.indexOf("DOCKER pull")).toBeLessThan(commands.indexOf("DOCKER stop --time 120 atelier-system"));
  expect(commands.indexOf("DOCKER stop")).toBeLessThan(commands.indexOf("DOCKER rm atelier-system"));
  expect(commands).toContain("--mount source=atelier-system,target=/data");
  expect(commands).not.toContain("volume rm");
});

test("failed pull leaves existing System untouched", () => {
  const result = run({ installed: true, pullFails: true });
  expect(result.status).not.toBe(0);
  expect(result.output).not.toContain("DOCKER stop");
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("DOCKER run");
});

test("connect requests System-owned reconnection without downloading or replacing images", () => {
  const result = run({ installed: true }, ["--action", "connect"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("http://127.0.0.1:3001/connect");
  expect(result.output).not.toContain("DOCKER pull");
  expect(result.output).not.toContain("DOCKER stop");
});

test("old installation is rejected without migration", () => {
  const result = run({ old: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("does not migrate");
  expect(result.output).not.toContain("DOCKER pull");
});

test("invalid action is rejected before Docker changes", () => {
  const result = run({}, ["--action", "destroy"]);
  expect(result.status).not.toBe(0);
  expect(result.output).not.toContain("DOCKER");
});


test("missing filesystem driver fails before image pull or System replacement", () => {
  const result = run({ installed: true, missingFilesystem: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("does not have erofs, which Atelier requires");
  expect(result.output).not.toContain("DOCKER pull");
  expect(result.output).not.toContain("DOCKER stop");
});


test("loads an available filesystem module before starting System", () => {
  const result = run({ missingFilesystem: true, loadable: true });
  expect(result.status).toBe(0);
  expect(result.output).toContain("MODPROBE erofs");
  expect(result.output.indexOf("MODPROBE erofs")).toBeLessThan(result.output.indexOf("DOCKER pull"));
});

test("supervisor failure stops System without removing its container or data", () => {
  const result = run({ appFails: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("3001/status");
  expect(result.output).toContain("DOCKER stop --time 120 atelier-system");
  expect(result.output).not.toContain("DOCKER rm");
  expect(result.output).not.toContain("volume rm");
});

test("waits for supervisor readiness without interpreting the activity description", () => {
  const result = run({ pendingHealth: true });
  expect(result.status).toBe(0);
  expect(result.output.match(/http:\/\/127\.0\.0\.1:3001\/status/g)?.length).toBe(2);
});


test("macOS starts System directly without a temporary check container or host module changes", () => {
  const result = run({ mac: true, missingFilesystem: true });
  expect(result.status).toBe(0);
  expect(result.output).not.toContain("DOCKER run --rm");
  expect(result.output).not.toContain("MODPROBE");
  expect(result.output).toContain("Open https://app.example/custom-path");
});


test("desktop defaults local while an explicit access choice overrides the OS", () => {
  const mac = run({ mac: true });
  expect(mac.status).toBe(0);
  expect(mac.output).toContain("--access-mode localhost");
  const wsl = run({ wsl: true });
  expect(wsl.status).toBe(0);
  expect(wsl.output).toContain("--access-mode localhost");
  const remote = run({ mac: true }, ["--access-mode", "tailscale"]);
  expect(remote.status).toBe(0);
  expect(remote.output).toContain("--access-mode tailscale");
});


for (const action of ["open", "connect"]) {
  test(`${action} does not require local access support from an existing System`, () => {
    const result = run({ installed: true }, ["--action", action]);
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("3080/tcp");
    expect(result.output).not.toContain("3001/access");
    expect(result.output).not.toContain("DOCKER stop");
  });
}


test("Linux requests sudo itself while Mac and WSL with Docker access do not", () => {
  const linux = run({ nonRoot: true });
  expect(linux.status).toBe(0);
  expect(linux.output).toContain("SUDO -v");
  expect(linux.output).toContain("SUDO mkdir -p /etc/modules-load.d");
  for (const options of [{ mac: true }, { wsl: true, nonRoot: true }, {}]) {
    expect(run(options).output).not.toContain("SUDO");
  }
});

test("denied sudo fails before changing the Linux host", () => {
  const result = run({ nonRoot: true, denySudo: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("administrator access was not granted");
  expect(result.output).not.toContain("DOCKER pull");
  expect(result.output).not.toContain("MODPROBE");
});

for (const state of ["restarting", "exited"] as const) {
  for (const action of ["update", "open"] as const) {
    test(`${action} stops waiting and shows container logs when System is ${state}`, () => {
      const result = run({ installed: true, systemState: state }, ["--action", action]);
      expect(result.status).toBe(1);
      expect(result.output).toContain(`Atelier services are ${state}`);
      expect(result.output).toContain("supervisor startup failed: io.weight unavailable");
      expect(result.output).not.toContain("Waiting for the supervisor");
      expect(result.output).not.toContain("http://127.0.0.1:3001/status");
    });
  }
}

for (const action of ["open", "connect"]) {
  test(`${action} stops an existing System when its status reports failure`, () => {
    const result = run({ installed: true, appFails: true }, ["--action", action]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("DOCKER stop --time 120 atelier-system");
    expect(result.output).not.toContain("DOCKER rm");
  });
}
