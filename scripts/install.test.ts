import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = (await Bun.file(new URL("./install.sh", import.meta.url)).text()).replace(/\nmain "\$@"\s*$/, "\n");

function run(body: string) {
  const result = Bun.spawnSync(["bash", "-c", `${installer}\n${body}`], { stdin: "ignore" });
  return { status: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

for (const [limit, swap, succeeds] of [
  ["0", 1024, true],
  ["max", 0, false],
  [undefined, 0, true],
  [undefined, 1024, false],
  [undefined, "", false],
] as const) {
  test(`workspace swap: limit=${limit}, SwapTotal=${swap}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "atelier-swap-test-"));
    try {
      if (limit !== undefined) writeFileSync(join(dir, "memory.swap.max"), limit);
      const result = run(`awk() { printf '%s\\n' '${swap}'; }
verify_workspace_swap_limit '${dir}'`);
      expect(result.status === 0).toBe(succeeds);
      if (limit === undefined && succeeds) expect(result.output).toContain("Keep host swap disabled");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
}

test("pulls and reads both images for the Docker server architecture", () => {
  const result = run(`
atelier_image=example/atelier:stable
docker() {
  printf '%s\\n' "$*" >&2
  case "$1" in
    version) printf 'linux/arm64\\n' ;;
    run) printf 'example/workspace:hash\\n' ;;
  esac
}
pull_atelier_images`);
  expect(result.status).toBe(0);
  expect(result.output).toContain("pull --platform linux/arm64 example/atelier:stable");
  expect(result.output).toContain("run --rm --platform linux/arm64 --entrypoint cat example/atelier:stable");
  expect(result.output).toContain("pull --platform linux/arm64 example/workspace:hash");
});

test("a missing host image fails before executing the image, including in a waited background job", () => {
  const result = run(`
atelier_image=example/atelier:stable
docker() {
  case "$1" in
    version) printf 'linux/arm64\\n' ;;
    pull) return 1 ;;
    run) printf 'UNEXPECTED EXECUTION\\n' >&2 ;;
  esac
}
pull_atelier_images &
wait "$!" || exit "$?"`);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("could not pull Atelier image example/atelier:stable for linux/arm64");
  expect(result.output).not.toContain("UNEXPECTED EXECUTION");
});

test("installation uses default standalone startup with persistent backing and stops the previous owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-install-runtime-"));
  try {
    const result = run(`
atelier_data_dir='${dir}'
atelier_image=example/atelier:stable
atelier_public_host=atelier.example
chown() { :; }
docker() {
  printf 'DOCKER %s\\n' "$*" >&2
  if [ "$1" = ps ]; then
    case "$*" in *atelier-updater*) ;; *) echo existing ;; esac
  fi
}
install_atelier`);
    expect(result.status).toBe(0);
    expect(result.output).toContain("stop --time 30 atelier");
    expect(result.output).toContain("--privileged");
    expect(result.output).toContain(`type=bind,src=${dir}/docker-runtime,dst=${dir}/docker-runtime`);
    const launch = result.output.split("\n").find((line) => line.startsWith("DOCKER run -d "))!;
    expect(launch.endsWith(" example/atelier:stable")).toBe(true);
    expect(launch).not.toContain("--nested");
    expect(launch).not.toContain("--own-snapshotter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
