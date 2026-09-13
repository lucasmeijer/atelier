// bun images/patched-docker/smoke-test.ts [image] [linux/arm64|linux/amd64]
// Requires Docker, network access for the fixture, and a Linux kernel with EROFS.
// Each run owns its containers/volumes and removes them, including on failure.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = process.argv[2] ?? "atelier-patched-docker:dev";
const platform = process.argv[3] ?? "linux/arm64";
assert(["linux/arm64", "linux/amd64"].includes(platform));
const architecture = platform.split("/")[1];
const id = `atelier-runtime-smoke-${architecture}-${process.pid}`;
const producer = `${id}-producer`;
const consumer = `${id}-consumer`;
const cache = `${id}-cache`;
const volumes = [cache, `${producer}-data`, `${consumer}-data`];
const containers: string[] = [];
const createdVolumes: string[] = [];
const context = await mkdtemp(join(tmpdir(), "atelier-runtime-smoke-"));
const base = "docker.io/library/golang:1.24.5@sha256:ef5b4be1f94b36c90385abd9b6b4f201723ae28e71acacb76d00687333c17282";

async function command(args: string[], check = true) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (check) assert.equal(code, 0, `${args.join(" ")}\n${stdout}\n${stderr}`);
  return { stdout, stderr, code };
}
async function exec(container: string, ...args: string[]) {
  return (await command(["docker", "exec", container, ...args])).stdout;
}
async function ctr(container: string, ...args: string[]) {
  return exec(container, "ctr", "--namespace", "moby", ...args);
}
async function ready(container: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await command(["docker", "exec", container, "docker", "info"], false);
    if (result.code === 0) return;
    const running = await command(["docker", "inspect", "--format", "{{.State.Running}}", container]);
    if (running.stdout.trim() !== "true") break;
    await Bun.sleep(500);
  }
  assert.fail(await execLogs(container));
}
async function execLogs(container: string) {
  const logs = await command(["docker", "logs", container], false);
  return logs.stdout + logs.stderr;
}
async function start(container: string, readonly: boolean) {
  await command(["docker", "run", "--detach", "--privileged", "--platform", platform,
    "--name", container, "--mount", `type=volume,src=${container}-data,dst=/var/lib/docker`,
    "--mount", `type=volume,src=${cache},dst=/erofs-cache${readonly ? ",readonly" : ""}`,
    image]);
  containers.push(container);
  await ready(container);
}
interface Descriptor { digest: string; platform?: { os: string; architecture: string } }
interface Manifest { manifests?: Descriptor[]; layers?: Descriptor[] }
async function layers(container: string) {
  const listing = await ctr(container, "images", "list");
  let digest = listing.trim().split("\n")[1].split(/\s+/)[2];
  for (;;) {
    const manifest: Manifest = JSON.parse(await ctr(container, "content", "get", digest));
    if (manifest.layers) return manifest.layers.map((layer) => layer.digest);
    const selected = manifest.manifests?.find((entry) =>
      entry.platform?.os === "linux" && entry.platform.architecture === architecture);
    assert(selected, "fixture has no matching platform");
    digest = selected.digest;
  }
}
async function cacheHashes() {
  return exec(consumer, "sh", "-c", "find /erofs-cache -name '*.erofs' -type f -exec sha256sum {} + | sort");
}
try {
  for (const volume of volumes) {
    await command(["docker", "volume", "create", volume]);
    createdVolumes.push(volume);
  }
  await start(producer, false);
  console.log(`${platform}: fetching fixture and preparing EROFS cache`);
  await ctr(producer, "content", "fetch", "--platform", platform, base);
  const baseLayers = await layers(producer);
  assert(baseLayers.length > 1, "exercise reuse across multiple cached layers");
  await ctr(producer, "images", "build-erofs-cache", "--platform", platform, base, "/erofs-cache");
  await start(consumer, true);
  const hashes = await cacheHashes();
  const started = performance.now();
  await ctr(consumer, "images", "pull", "--platform", platform, "--snapshotter", "erofs", base);
  console.log(`${platform}: preload ${((performance.now() - started) / 1000).toFixed(2)}s`);
  const assertNoBaseBlobs = async () => {
    const content = new Set((await ctr(consumer, "content", "list", "--quiet")).trim().split("\n"));
    for (const digest of baseLayers) assert(!content.has(digest), `base blob downloaded: ${digest}`);
  };
  await assertNoBaseBlobs();
  const links = await exec(consumer, "sh", "-c", "find /var/lib/docker/containerd/io.containerd.snapshotter.v1.erofs/snapshots -name layer.erofs -type l -exec readlink {} +");
  assert.equal(links.trim().split("\n").length, baseLayers.length);
  assert(links.trim().split("\n").every((link) => link.startsWith("/erofs-cache/")));
  await writeFile(join(context, "hello.go"), 'package main\nimport "fmt"\nfunc main(){fmt.Println("shared EROFS build works")}\n');
  await writeFile(join(context, "Dockerfile"), `FROM ${base}\nCOPY hello.go /src/hello.go\nRUN CGO_ENABLED=0 go build -o /hello /src/hello.go\nCMD ["/hello"]\n`);
  await command(["docker", "cp", context, `${consumer}:/context`]);
  const buildStarted = performance.now();
  const build = await exec(consumer, "docker", "build", "--network=none", "--no-cache", "--progress=plain",
    "--output", "type=image,store-allow-incomplete=true", "--tag", "smoke:result", "/context");
  console.log(`${platform}: build ${((performance.now() - buildStarted) / 1000).toFixed(2)}s`, build);
  await assertNoBaseBlobs();
  assert.equal(await cacheHashes(), hashes);
  assert.match(await exec(consumer, "docker", "run", "--rm", "--network=none", "smoke:result"), /shared EROFS build works/);
  await command(["docker", "restart", "--time", "30", consumer]);
  await ready(consumer);
  assert.match(await exec(consumer, "docker", "run", "--rm", "--network=none", "smoke:result"), /shared EROFS build works/);
  await assertNoBaseBlobs();
  assert.equal(await cacheHashes(), hashes);
  // Failure of either managed daemon must terminate the container, not leave it healthy.
  await exec(consumer, "sh", "-c", "kill -TERM $(cat /var/run/docker.pid)");
  const exitCode = await command(["docker", "wait", consumer]);
  assert.equal(exitCode.stdout.trim(), "0");
  console.log(`${platform}: PASS (${baseLayers.length} cached base layers; no base blobs fetched; restart and supervision passed)`);
} catch (error) {
  for (const container of containers) console.error(await execLogs(container));
  throw error;
} finally {
  for (const container of containers.reverse()) await command(["docker", "rm", "--force", container]);
  for (const volume of createdVolumes.reverse()) await command(["docker", "volume", "rm", volume]);
  await rm(context, { recursive: true });
}
