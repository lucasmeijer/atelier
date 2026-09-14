import { expect, test } from "bun:test";

const installer = await Bun.file(new URL("./install.sh", import.meta.url)).text();

function run(options: { installed?: boolean; old?: boolean; pullFails?: boolean; running?: boolean; missingFilesystem?: boolean; loadable?: boolean } = {}, args = ["--non-interactive"]) {
  const mock = `
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
    'exec atelier-system') printf '${options.running === false ? "NeedsLogin" : "Running"}\\natelier.example.ts.net\\n' ;;
    'inspect --format') echo true ;;
  esac
}
`;
  const result = Bun.spawnSync(["bash", "-c", mock + installer.replace("> /etc/modules-load.d/atelier-system.conf", "> /dev/null"), "installer", ...args], { stdin: "ignore" });
  return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

test("fresh install launches privileged System with persistent named volume and bootstrap app", () => {
  const result = run({}, ["--non-interactive", "--system-image", "test/system:v1", "--app-image", "test/app:v1"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER pull test/system:v1");
  expect(result.output).toContain("--name atelier-system --hostname atelier-system --privileged --restart unless-stopped --stop-timeout 120 --tmpfs /run --mount source=atelier-system,target=/data test/system:v1 --app-image test/app:v1");
  expect(result.output).not.toContain("DOCKER stop");
  expect(result.output).toContain("https://atelier.example.ts.net:8443");
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

test("noninteractive installation prints login command instead of waiting for login", () => {
  const result = run({ running: false });
  expect(result.status).toBe(0);
  expect(result.output).toContain("docker exec -it atelier-system tailscale up");
  expect(result.output).not.toContain("DOCKER exec atelier-system tailscale up");
});

test("connect operates Tailscale in System without downloading or replacing images", () => {
  const result = run({ installed: true }, ["--action", "connect"]);
  expect(result.status).toBe(0);
  expect(result.output).toContain("DOCKER exec atelier-system tailscale up");
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
