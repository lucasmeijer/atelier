import { expect, test } from "bun:test";

const installer = await Bun.file(new URL("./install.sh", import.meta.url)).text();

function run(options: { installed?: boolean; old?: boolean; pullFails?: boolean; running?: boolean; appFails?: boolean; pendingHealth?: boolean; missingFilesystem?: boolean; loadable?: boolean } = {}, args = ["--non-interactive"]) {
  const logPath = `/tmp/atelier-install-test-${crypto.randomUUID()}.log`;
  const mock = `
mktemp() { echo "${logPath}"; }
sleep() { command sleep 0.01; }
uname() { echo Linux; }
id() { echo 0; }
module_loaded=0
grep() { [ "$module_loaded" -eq 1 ] || return ${options.missingFilesystem ? 1 : 0}; }
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
        printf '${options.appFails ? 'failed\\nApp health failed\\n\\n\\nhttps://diagnostics.example/system\\n\\n\\nSystem logs\\nApp exited' : options.running === false ? 'starting\\nWaiting for your connection\\n\\n\\n\\nSign in to continue\\nhttps://auth.example/sign-in\\n' : 'ready\\nAtelier is ready\\n\\nhttps://app.example/custom-path\\nhttps://diagnostics.example/system\\n\\n\\n'}\\n'
        return
      fi ;;
    'inspect --format') echo true ;;
  esac
}
`;
  const result = Bun.spawnSync(["bash", "-c", mock + installer.replace("> /etc/modules-load.d/atelier-system.conf", "> /dev/null"), "installer", ...args], { stdin: "ignore" });
  const log = Bun.spawnSync(["cat", logPath]).stdout.toString();
  Bun.spawnSync(["rm", "-f", logPath, `${logPath}.checked`]);
  return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() + log };
}

test("fresh install launches privileged System with persistent named volume and bootstrap app", () => {
  const result = run({}, ["--non-interactive", "--system-image", "test/system:v1", "--app-image", "test/app:v1"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER pull test/system:v1");
  expect(result.output).toContain("--name atelier-system --hostname atelier-system --privileged --cgroupns=host --restart unless-stopped --stop-timeout 120 --tmpfs /run --mount source=atelier-system,target=/data test/system:v1 --app-image test/app:v1");
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

test("noninteractive installation yields for a System-owned user action", () => {
  const result = run({ running: false });
  expect(result.status).toBe(0);
  expect(result.output.match(/http:\/\/127\.0\.0\.1:3001\/status/g)?.length).toBe(1);
  expect(result.output).not.toContain("DOCKER exec atelier-system tailscale");
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
  expect(result.output).toContain("erofs is unavailable");
  expect(result.output).not.toContain("DOCKER pull");
  expect(result.output).not.toContain("DOCKER stop");
});


test("loads an available filesystem module before starting System", () => {
  const result = run({ missingFilesystem: true, loadable: true });
  expect(result.status).toBe(0);
  expect(result.output).toContain("MODPROBE erofs");
  expect(result.output.indexOf("MODPROBE erofs")).toBeLessThan(result.output.indexOf("DOCKER pull"));
});

test("supervisor failure makes installation fail without replacing services again", () => {
  const result = run({ appFails: true });
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("3001/status");
  expect(result.output).not.toContain("DOCKER stop");
});

test("waits for supervisor readiness without interpreting the activity description", () => {
  const result = run({ pendingHealth: true });
  expect(result.status).toBe(0);
  expect(result.output.match(/http:\/\/127\.0\.0\.1:3001\/status/g)?.length).toBe(2);
});
