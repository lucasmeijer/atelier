import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectImage, parseReleaseArgs, promoteChannels, release, verifyRevision, type ReleaseStatus, type Run } from "./release.ts";

const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const architectures = ["amd64", "arm64"];
const manifest = {
  digest,
  manifests: architectures.map((architecture, index) => ({ digest: `sha256:${String(index + 1).repeat(64)}`, platform: { os: "linux", architecture } })),
};
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
function status(stable = false): ReleaseStatus {
  return { state: "running", phase: "Starting", startedAt: "", updatedAt: "", elapsedSeconds: 0, check: false, commit, digest, channels: stable ? { latest: "pending", stable: "pending" } : { latest: "pending" } };
}

test("release only supports latest or both, plus non-publishing checks", () => {
  expect(parseReleaseArgs([])).toEqual({ stable: false, check: false, help: false });
  expect(parseReleaseArgs(["--stable", "--check"])).toEqual({ stable: true, check: true, help: false });
  expect(() => parseReleaseArgs(["--channel", "stable"])).toThrow("Unknown release option");
});

test("registry absence is distinct from authentication or network failure", async () => {
  expect(await inspectImage(async () => ({ code: 1, stdout: "", stderr: "ERROR: example: not found" }), "example", true)).toBeUndefined();
  for (const stderr of ["unauthorized", "connection refused", "TLS handshake timeout"]) {
    await expect(inspectImage(async () => ({ code: 1, stdout: "", stderr }), "example", true)).rejects.toThrow("Cannot inspect");
  }
});

test("verification requires both architectures and matching revision labels", async () => {
  await expect(inspectImage(async () => ok(JSON.stringify({ ...manifest, manifests: manifest.manifests.slice(0, 1) })), "ref")).rejects.toThrow("linux/arm64");
  const run: Run = async (args) => {
    if (args.includes("{{json .Manifest}}")) return ok(JSON.stringify(manifest));
    const index = manifest.manifests.findIndex((entry) => args.some((arg) => arg.endsWith(entry.digest)));
    return ok(JSON.stringify({ os: "linux", architecture: architectures[index], config: { Labels: { "org.opencontainers.image.revision": commit } } }));
  };
  expect(await verifyRevision(run, "ref", commit)).toBe(digest);
  await expect(verifyRevision(run, "ref", "wrong-sha")).rejects.toThrow("does not match revision");
});

test("promotion uses the verified digest and reports partial success", async () => {
  const current = status(true);
  const calls: string[][] = [];
  const saves: string[] = [];
  await expect(promoteChannels(async (args) => {
    calls.push(args);
    if (args.includes("create") && args.some((arg) => arg.endsWith(":stable"))) throw new Error("push failed");
    return ok(JSON.stringify(manifest));
  }, current, () => saves.push(JSON.stringify(current.channels)))).rejects.toThrow("push failed");
  expect(current.channels).toEqual({ latest: "published", stable: "failed" });
  expect(calls.filter((args) => args.includes("create")).every((args) => args.at(-1) === `ghcr.io/lucasmeijer/atelier@${digest}`)).toBe(true);
  expect(saves.length).toBe(4);
});

test("both channels are promoted in order on success", async () => {
  const current = status(true);
  const channels: string[] = [];
  await promoteChannels(async (args) => {
    if (args.includes("create")) channels.push(args[args.indexOf("--tag") + 1]!);
    return ok(JSON.stringify(manifest));
  }, current, () => {});
  expect(channels).toEqual(["ghcr.io/lucasmeijer/atelier:latest", "ghcr.io/lucasmeijer/atelier:stable"]);
  expect(current.channels).toEqual({ latest: "published", stable: "published" });
});

test("promotion fails if registry readback differs", async () => {
  const current = status();
  await expect(promoteChannels(async () => ok(JSON.stringify({ ...manifest, digest: `sha256:${"c".repeat(64)}` })), current, () => {})).rejects.toThrow("digest differs");
  expect(current.channels.latest).toBe("failed");
});

async function scenario(options: { check?: boolean; exists?: boolean; moved?: boolean; buildFailure?: boolean; native?: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), "atelier-release-test-"));
  const calls: { args: string[]; cwd?: string }[] = [];
  let uploaded = options.exists ?? false;
  const current = status();
  current.digest = undefined;
  current.check = options.check ?? false;
  const oldToken = process.env.GH_PACKAGE_TOKEN;
  process.env.GH_PACKAGE_TOKEN = "test-not-a-real-credential";
  try {
    const run: Run = async (args, command) => {
      calls.push({ args, cwd: command?.cwd });
      if (args[0] === "git" && args[1] === "rev-parse") return ok(commit);
      if (args[0] === "git" && args[1] === "ls-remote") return ok(`${options.moved ? "new-commit" : commit}\trefs/heads/main`);
      if (args[0] === "docker" && args[2] === "inspect") return ok(`org.mobyproject.buildkit.worker.snapshotter: ${options.native ? "native" : "fuse-overlayfs"}`);
      if (args.includes("imagetools") && args.includes("{{json .Manifest}}")) {
        if (!uploaded) return { code: 1, stdout: "", stderr: "ERROR: image: not found" };
        return ok(JSON.stringify(manifest));
      }
      if (args.includes("{{json .Image}}")) {
        const index = manifest.manifests.findIndex((entry) => args.some((arg) => arg.endsWith(entry.digest)));
        return ok(JSON.stringify({ os: "linux", architecture: architectures[index], config: { Labels: { "org.opencontainers.image.revision": commit } } }));
      }
      if (args[0] === "bun") {
        if (options.buildFailure) throw new Error("build failed");
        uploaded = true;
      }
      return ok();
    };
    let error: unknown;
    try { await release({ check: current.check, stable: false, help: false }, run, current, () => {}, directory); }
    catch (caught) { error = caught; }
    return { calls, current, error };
  } finally {
    if (oldToken === undefined) delete process.env.GH_PACKAGE_TOKEN;
    else process.env.GH_PACKAGE_TOKEN = oldToken;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("check exercises both platforms without registry writes or worktree creation", async () => {
  const { calls, current, error } = await scenario({ check: true });
  expect(error).toBeUndefined();
  expect(current.state).toBe("checked");
  expect(calls.some(({ args }) => args.includes("linux/amd64,linux/arm64"))).toBe(true);
  expect(calls.some(({ args }) => args.includes("login") || args.includes("--push") || args.includes("imagetools") || args.includes("worktree"))).toBe(false);
});

test("a native snapshotter stops the release before publishing", async () => {
  const { calls, error } = await scenario({ native: true });
  expect(String(error)).toContain("not using fuse-overlayfs");
  expect(calls.some(({ args }) => args.includes("login"))).toBe(false);
});

test("new commit is built in an isolated checkout with no latest tag before verification", async () => {
  const { calls, current, error } = await scenario({});
  expect(error).toBeUndefined();
  expect(current.state).toBe("published");
  const build = calls.find(({ args }) => args[0] === "bun")!;
  expect(build.cwd).toEndWith("/source");
  expect(build.args).toContain("--no-latest");
  expect(build.args).toContain(`sha-${commit}`);
  expect(build.args).toContain("--builder");
  expect(calls.some(({ args }) => args.includes("--stable"))).toBe(false);
  expect(calls.findIndex(({ args }) => args.includes("{{json .Image}}"))).toBeLessThan(calls.findIndex(({ args }) => args.includes("--tag") && args.includes("ghcr.io/lucasmeijer/atelier:latest")));
});

test("retry reuses uploaded commit instead of rebuilding", async () => {
  const { calls, error } = await scenario({ exists: true });
  expect(error).toBeUndefined();
  expect(calls.some(({ args }) => args[0] === "bun" || args.includes("worktree"))).toBe(false);
});

test("main moving prevents all channel updates", async () => {
  const { calls, error } = await scenario({ exists: true, moved: true });
  expect(String(error)).toContain("origin/main moved");
  expect(calls.some(({ args }) => args.includes("imagetools") && args.includes("create"))).toBe(false);
});

test("failed build removes checkout and does not promote", async () => {
  const { calls, error } = await scenario({ buildFailure: true });
  expect(String(error)).toContain("build failed");
  expect(calls.some(({ args }) => args[0] === "git" && args.includes("remove"))).toBe(true);
  expect(calls.some(({ args }) => args.includes("imagetools") && args.includes("create"))).toBe(false);
});

test("image build CLI stages both images on the explicit builder without channel tags", async () => {
  const directory = mkdtempSync(join(tmpdir(), "atelier-release-cli-test-"));
  const log = join(directory, "docker.jsonl");
  const docker = join(directory, "docker");
  writeFileSync(docker, `#!/usr/bin/env bun\nimport { appendFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\nif (args.includes('inspect')) process.exit(1);\n`);
  chmodSync(docker, 0o755);
  try {
    const process = Bun.spawn(["bun", join(import.meta.dir, "build-atelier-image.ts"), "--push", "--no-latest", "--tag", "sha-test", "--builder", "test-fuse", "--platform", "linux/amd64,linux/arm64"], {
      cwd: join(import.meta.dir, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, PATH: `${directory}:${Bun.env.PATH}`, GH_PACKAGE_TOKEN: "test-not-a-real-credential" },
    });
    const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text(), new Response(process.stdout).text()]);
    expect(stderr).not.toContain("error:");
    expect(code).toBe(0);
    const commands: string[][] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const builds = commands.filter((args) => args[0] === "buildx" && args[1] === "build");
    expect(builds).toHaveLength(2);
    for (const args of builds) {
      expect(args[args.indexOf("--builder") + 1]).toBe("test-fuse");
      expect(args).toContain("--push");
      expect(args).toContain("linux/amd64,linux/arm64");
      expect(args.some((arg) => arg.endsWith(":latest") || arg.endsWith(":stable"))).toBe(false);
    }
    expect(builds[1]).toContain("ghcr.io/lucasmeijer/atelier:sha-test");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
