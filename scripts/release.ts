#!/usr/bin/env bun
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";

const image = "ghcr.io/lucasmeijer/atelier";
const platforms = ["linux/amd64", "linux/arm64"];
const root = resolve(import.meta.dir, "..");
export const usage = `Release Atelier from the current origin/main commit.

  bun run release             Publish latest
  bun run release --stable    Publish latest and stable
  bun run release --check     Check Git, FUSE builder and both architectures; publish nothing

--check may be combined with --stable. Working files are never released or reset.
Uses the existing GH_PACKAGE_TOKEN for publishing. Logs/status live under Git's
common directory in atelier-releases/<run-id>/. See docs/releases.md.
`;

export function parseReleaseArgs(args: string[]) {
  for (const arg of args) {
    if (!["--stable", "--check", "--help", "-h"].includes(arg)) throw new Error(`Unknown release option: ${arg}`);
  }
  return { stable: args.includes("--stable"), check: args.includes("--check"), help: args.includes("--help") || args.includes("-h") };
}

type ChannelState = "pending" | "promoting" | "published" | "failed";
export interface ReleaseStatus {
  state: "running" | "checked" | "published" | "failed";
  phase: string;
  startedAt: string;
  updatedAt: string;
  elapsedSeconds: number;
  check: boolean;
  commit?: string;
  builder?: string;
  digest?: string;
  channels: Partial<Record<"latest" | "stable", ChannelState>>;
  error?: string;
}
interface Result { code: number; stdout: string; stderr: string }
interface CommandOptions { cwd?: string; input?: string; allowFailure?: boolean; stream?: boolean }
export type Run = (args: string[], options?: CommandOptions) => Promise<Result>;

const digestSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const manifestSchema = Type.Object({
  digest: digestSchema,
  manifests: Type.Array(Type.Object({
    digest: digestSchema,
    platform: Type.Object({ os: Type.String(), architecture: Type.String() }),
  })),
});
const configSchema = Type.Object({
  os: Type.String(), architecture: Type.String(),
  config: Type.Object({ Labels: Type.Record(Type.String(), Type.String()) }),
});

export async function inspectImage(run: Run, ref: string, optional = false) {
  const result = await run(["docker", "buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"], { allowFailure: optional });
  if (result.code !== 0) {
    // Only a registry's explicit absence is a cache miss, never authentication/network failures.
    if (optional && /manifest unknown|: not found\b/i.test(result.stderr)) return undefined;
    throw new Error(`Cannot inspect ${ref}: ${result.stderr}`);
  }
  const manifest = Value.Parse(manifestSchema, JSON.parse(result.stdout));
  for (const platform of platforms) {
    if (manifest.manifests.filter((entry) => `${entry.platform.os}/${entry.platform.architecture}` === platform).length !== 1) {
      throw new Error(`${ref} must contain exactly one ${platform} image`);
    }
  }
  return manifest;
}

export async function verifyRevision(run: Run, ref: string, commit: string): Promise<string> {
  const manifest = (await inspectImage(run, ref))!;
  for (const platform of platforms) {
    const entry = manifest.manifests.find((entry) => `${entry.platform.os}/${entry.platform.architecture}` === platform)!;
    const result = await run(["docker", "buildx", "imagetools", "inspect", `${image}@${entry.digest}`, "--format", "{{json .Image}}"]);
    const config = Value.Parse(configSchema, JSON.parse(result.stdout));
    if (`${config.os}/${config.architecture}` !== platform || config.config.Labels["org.opencontainers.image.revision"] !== commit) {
      throw new Error(`${ref}: ${platform} does not match revision ${commit}`);
    }
  }
  return manifest.digest;
}

export async function promoteChannels(run: Run, status: ReleaseStatus, save: () => void): Promise<void> {
  for (const channel of ["latest", "stable"] as const) {
    if (status.channels[channel] === undefined) continue;
    status.phase = `Promote ${channel}`;
    status.channels[channel] = "promoting";
    save();
    try {
      await run(["docker", "buildx", "imagetools", "create", "--tag", `${image}:${channel}`, `${image}@${status.digest}`], { stream: true });
      const published = (await inspectImage(run, `${image}:${channel}`))!;
      if (published.digest !== status.digest) throw new Error(`${channel}: registry digest differs from release digest`);
      status.channels[channel] = "published";
      save();
    } catch (error) {
      // A failed response can follow a successful registry write; do not claim rollback.
      status.channels[channel] = "failed";
      save();
      throw error;
    }
  }
}

async function ensureBuilder(run: Run, directory: string): Promise<string> {
  const dockerfile = await Bun.file(join(root, "scripts/release-builder/Dockerfile")).text();
  const hash = createHash("sha256").update(dockerfile).digest("hex").slice(0, 12);
  const builder = `atelier-release-fuse-${hash}`;
  const builderImage = `atelier-buildkit-fuse:${hash}`;
  const existing = await run(["docker", "buildx", "ls", "--format", "{{.Name}}"]);
  if (!existing.stdout.split(/\s+/).includes(builder)) {
    // Explicitly use workspace Docker's fast storage driver to build BuildKit itself.
    await run(["docker", "buildx", "build", "--builder", "default", "--load", "--progress", "plain", "--tag", builderImage, join(root, "scripts/release-builder")], { stream: true });
    await run(["docker", "buildx", "create", "--name", builder, "--driver", "docker-container", "--driver-opt", `image=${builderImage}`, "--buildkitd-flags", "--oci-worker-snapshotter=fuse-overlayfs"]);
  }
  const inspection = await run(["docker", "buildx", "inspect", builder, "--bootstrap"]);
  if (!/worker\.snapshotter:\s+fuse-overlayfs\b/.test(inspection.stdout)) throw new Error(`${builder} is not using fuse-overlayfs`);

  // Exercise RUN, COPY, and a locally exported manifest for both targets, not just advertised support.
  const probe = join(directory, "probe");
  mkdirSync(probe);
  writeFileSync(join(probe, "marker"), "Atelier release builder check\n");
  writeFileSync(join(probe, "Dockerfile"), "FROM ubuntu:26.04\nCOPY marker /marker\nRUN cat /marker && test -x /bin/sh && uname -m\n");
  await run(["docker", "buildx", "build", "--builder", builder, "--platform", platforms.join(","), "--provenance=false", "--progress", "plain", "--output", `type=oci,dest=${join(directory, "probe.oci.tar")}`, probe], { stream: true });
  return builder;
}

export async function release(options: ReturnType<typeof parseReleaseArgs>, run: Run, status: ReleaseStatus, save: () => void, directory: string): Promise<void> {
  const phase = (text: string) => { status.phase = text; save(); };
  phase("Resolve origin/main");
  await run(["git", "fetch", "origin", "refs/heads/main"]);
  status.commit = (await run(["git", "rev-parse", "FETCH_HEAD^{commit}"])).stdout.trim();
  save();
  phase("Prepare and check FUSE builder");
  status.builder = await ensureBuilder(run, directory);
  save();
  if (options.check) {
    status.state = "checked";
    phase("Check complete — nothing published");
    return;
  }

  phase("Authenticate registry");
  const token = process.env.GH_PACKAGE_TOKEN?.trim();
  if (!token) throw new Error("GH_PACKAGE_TOKEN is required to publish a release");
  await run(["docker", "login", "ghcr.io", "--username", "lucasmeijer", "--password-stdin"], { input: token });
  const ref = `${image}:sha-${status.commit}`;
  phase("Look for an existing commit image");
  if (!await inspectImage(run, ref, true)) {
    const checkout = join(directory, "source");
    phase("Check out exact release commit");
    await run(["git", "worktree", "add", "--detach", checkout, status.commit]);
    try {
      phase("Build and upload commit images (no channel updates)");
      await run(["bun", join(root, "scripts/build-atelier-image.ts"), "--push", "--no-latest", "--tag", `sha-${status.commit}`, "--builder", status.builder, "--platform", platforms.join(","), "--progress", "plain"], { cwd: checkout, stream: true });
    } finally {
      await run(["git", "worktree", "remove", "--force", checkout]);
    }
  }
  phase("Verify both architectures and revision labels");
  status.digest = await verifyRevision(run, ref, status.commit);
  save();
  // Avoid promoting a build that was overtaken by new main commits while building.
  phase("Confirm main has not moved");
  const head = (await run(["git", "ls-remote", "origin", "refs/heads/main"])).stdout.split(/\s+/)[0];
  if (head !== status.commit) throw new Error("origin/main moved during this release. Commit image is uploaded; rerun to release the new main.");
  await promoteChannels(run, status, save);
  status.state = "published";
  phase(`Published ${Object.keys(status.channels).join(" + ")} — ${status.digest}`);
}

async function main(options: ReturnType<typeof parseReleaseArgs>, common: string): Promise<void> {
  const directory = join(common, "atelier-releases", `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, "release.log");
  const statusPath = join(directory, "status.json");
  const started = Date.now();
  const status: ReleaseStatus = {
    state: "running", phase: "Starting", startedAt: new Date(started).toISOString(), updatedAt: new Date(started).toISOString(), elapsedSeconds: 0,
    check: options.check, channels: options.stable ? { latest: "pending", stable: "pending" } : { latest: "pending" },
  };
  const output = (text: string) => { process.stdout.write(text); appendFileSync(logPath, text); };
  let lastPhase = "";
  const save = () => {
    status.updatedAt = new Date().toISOString();
    status.elapsedSeconds = Math.floor((Date.now() - started) / 1000);
    writeFileSync(`${statusPath}.tmp`, `${JSON.stringify(status, null, 2)}\n`);
    renameSync(`${statusPath}.tmp`, statusPath);
    if (status.phase !== lastPhase) {
      output(`\n\x1b[36m[${status.elapsedSeconds}s] ${status.phase}\x1b[0m\n`);
      lastPhase = status.phase;
    }
  };
  output(`Atelier release${options.check ? " CHECK (no publishing)" : ""}: ${Object.keys(status.channels).join(" + ")}\nLog: ${logPath}\nStatus: ${statusPath}\n`);
  writeFileSync(join(common, "atelier-releases", "last-run.txt"), `${directory}\n`);
  save();
  const heartbeat = setInterval(save, 5000);
  let active: ReturnType<typeof Bun.spawn> | undefined;
  let interrupted = false;
  const interrupt = () => { interrupted = true; active?.kill("SIGTERM"); };
  process.on("SIGTERM", interrupt);
  process.on("SIGINT", interrupt);
  const run: Run = async (args, command = {}) => {
    // Cleanup must still be able to remove a detached worktree after interruption.
    if (interrupted && !(args[0] === "git" && args[1] === "worktree" && args[2] === "remove")) throw new Error("Release interrupted");
    output(`$ ${args.map((arg) => JSON.stringify(arg)).join(" ")}\n`);
    const child = Bun.spawn(args, { cwd: command.cwd ?? root, stdin: command.input === undefined ? "ignore" : new TextEncoder().encode(command.input), stdout: "pipe", stderr: "pipe" });
    active = child;
    const consume = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      let collected = "";
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        output(text);
        if (!command.stream) collected += text;
      }
      const end = decoder.decode();
      output(end);
      return collected + end;
    };
    const [stdout, stderr, code] = await Promise.all([consume(child.stdout), consume(child.stderr), child.exited]);
    active = undefined;
    if (code !== 0 && !command.allowFailure) throw new Error(`${args.slice(0, 3).join(" ")} exited ${code}; see ${logPath}`);
    return { stdout, stderr, code };
  };
  try {
    await release(options, run, status, save, directory);
    if (interrupted) throw new Error("Release interrupted");
  } catch (error) {
    status.state = "failed";
    status.error = error instanceof Error ? error.message : String(error);
    output(`\nFAILED: ${status.error}\n`);
    process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    save();
    process.off("SIGTERM", interrupt);
    process.off("SIGINT", interrupt);
    output(`\n${JSON.stringify(status, null, 2)}\n`);
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const locked = args[0] === "--lock-held";
    const options = parseReleaseArgs(locked ? args.slice(1) : args);
    if (options.help) {
      console.log(usage);
    } else {
      const git = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      if (git.exitCode !== 0) throw new Error(git.stderr.toString());
      const common = git.stdout.toString().trim();
      if (locked) {
        await main(options, common);
      } else {
        // OS advisory lock is released even on crashes. Shared by worktrees, not remote workspaces.
        const child = Bun.spawn(["flock", "--nonblock", "--conflict-exit-code", "75", "--no-fork", join(common, "atelier-release.lock"), "bun", import.meta.path, "--lock-held", ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true });
        const stop = () => { process.kill(-child.pid, "SIGTERM"); };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        const code = await child.exited;
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        if (code === 75) console.error("Another release holds this repository's lock. Wait for it to finish.");
        else if (code !== 0) console.error("Release failed. See the log above.");
        process.exitCode = code;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
