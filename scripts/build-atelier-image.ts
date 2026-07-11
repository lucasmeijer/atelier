#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "node:fs";
import { arch, tmpdir } from "node:os";
import { join } from "node:path";

const usage = `Build the Atelier Docker image.

Usage:
  bun run scripts/build-atelier-image.ts [options]

Options:
  --image <name>        Image repository/name (default: ghcr.io/lucasmeijer/atelier)
  --tag <tag>           Tag to apply. May be passed more than once (default: git describe/short sha)
  --latest             Tag the image as <image>:latest (default)
  --stable             Also tag the image as <image>:stable
  --push               Push the built images instead of only loading them locally
  --platform <value>   Docker platform(s), e.g. linux/amd64 or linux/amd64,linux/arm64
  --builder-host <ssh> Docker SSH host to create/use as a buildx builder
  --no-cache           Build without Docker cache
  --workspace          Force building the default workspace image even when the deterministic tag already exists
  --progress <value>   Docker progress mode (auto, plain, tty, quiet, rawjson)
  --build-arg K=V      Extra Atelier app Docker build argument. May be passed more than once
  --help               Show this help

Examples:
  bun run image:build
  bun run image:build -- --tag v0.1.0 --latest
  bun run image:publish -- --stable --platform linux/amd64,linux/arm64
`;

interface Options {
  image: string;
  tags: string[];
  latest: boolean;
  stable: boolean;
  push: boolean;
  platform?: string;
  builderHost?: string;
  noCache: boolean;
  forceWorkspace: boolean;
  progress?: string;
  buildArgs: string[];
}

interface WorkspaceImageMetadata { tag: string }

const workspaceTempDir = mkdtempSync(join(tmpdir(), "atelier-image-"));
const workspaceContextDir = join(workspaceTempDir, "atelier-workspace");
process.on("exit", () => rmSync(workspaceTempDir, { recursive: true, force: true }));

function fail(message: string): never {
  console.error(`error: ${message}`);
  console.error("\n" + usage);
  process.exit(1);
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
  return value;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    image: "ghcr.io/lucasmeijer/atelier",
    tags: [],
    latest: true,
    stable: false,
    push: false,
    noCache: false,
    forceWorkspace: false,
    buildArgs: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    } else if (arg === "--image") {
      options.image = takeValue(args, i, arg);
      i++;
    } else if (arg === "--tag" || arg === "-t") {
      options.tags.push(takeValue(args, i, arg));
      i++;
    } else if (arg === "--latest") {
      options.latest = true;
    } else if (arg === "--stable") {
      options.stable = true;
    } else if (arg === "--push") {
      options.push = true;
    } else if (arg === "--platform") {
      options.platform = takeValue(args, i, arg);
      i++;
    } else if (arg === "--builder-host") {
      options.builderHost = takeValue(args, i, arg);
      i++;
    } else if (arg === "--no-cache") {
      options.noCache = true;
    } else if (arg === "--workspace") {
      options.forceWorkspace = true;
    } else if (arg === "--progress") {
      options.progress = takeValue(args, i, arg);
      i++;
    } else if (arg === "--build-arg") {
      options.buildArgs.push(takeValue(args, i, arg));
      i++;
    } else {
      fail(`unknown option: ${arg}`);
    }
  }

  return options;
}

function run(command: string[], options: { quiet?: boolean; inherit?: boolean } = {}): string {
  const result = Bun.spawnSync(command, {
    env: { ...process.env },
    stdout: options.inherit ? "inherit" : "pipe",
    stderr: options.inherit ? "inherit" : "pipe",
    stdin: "inherit",
  });
  const stdout = options.inherit ? "" : result.stdout.toString().trim();
  const stderr = options.inherit ? "" : result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    if (!options.quiet && !options.inherit) {
      if (stdout) console.error(stdout);
      if (stderr) console.error(stderr);
    }
    throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}`);
  }
  return stdout;
}

async function runInherited(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    env: { ...process.env },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
}

function maybeRun(command: string[]): string | undefined {
  try {
    return run(command, { quiet: true });
  } catch {
    return undefined;
  }
}

function dockerArchitecture(): string {
  const value = arch();
  if (value === "x64") return "amd64";
  if (value === "arm64") return "arm64";
  if (value === "arm") return "arm";
  return value;
}

function requestedPlatforms(options: Options): string[] {
  return options.platform?.split(",").map((platform) => platform.trim()).filter(Boolean) ?? [`linux/${dockerArchitecture()}`];
}

function localImageHasPlatforms(ref: string, platforms: string[]): boolean {
  const output = maybeRun(["docker", "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", ref]);
  if (!output) return false;
  const localPlatform = output.split(/\s+/)[0];
  return platforms.every((platform) => platform === localPlatform);
}

function registryImageHasPlatforms(ref: string, platforms: string[]): boolean {
  const text = maybeRun(["docker", "buildx", "imagetools", "inspect", ref]);
  if (!text) return false;
  const available = new Set([...text.matchAll(/^\s*Platform:\s*(\S+)/gm)].map((match) => match[1]!));
  if (available.size > 0) return platforms.every((platform) => available.has(platform));
  return platforms.length === 1 && /^MediaType:\s+application\/vnd\..*\.manifest\.v\d\+json$/m.test(text);
}

function workspaceImageExists(ref: string, options: Options): boolean {
  const platforms = requestedPlatforms(options);
  return options.push ? registryImageHasPlatforms(ref, platforms) : localImageHasPlatforms(ref, platforms);
}

function sanitizeTag(tag: string): string {
  const sanitized = tag.trim().replaceAll(/[^A-Za-z0-9_.-]/g, "-").replaceAll(/^[.-]+/g, "").slice(0, 128);
  return sanitized || "local";
}

function defaultTag(): string {
  return sanitizeTag(
    maybeRun(["git", "describe", "--tags", "--always", "--dirty"]) ||
    maybeRun(["git", "rev-parse", "--short=12", "HEAD"]) ||
    "local",
  );
}

function gitCommitId(): string {
  const commit = maybeRun(["git", "rev-parse", "HEAD"]);
  const dirty = maybeRun(["git", "status", "--porcelain"]) ? "-dirty" : "";
  return commit ? `${commit}${dirty}` : "unknown";
}

function gitCommitDescription(): string {
  return maybeRun(["git", "log", "-1", "--pretty=%s"]) || "local build";
}

function workspaceImageRepository(appImage: string): string {
  if (appImage === "ghcr.io/lucasmeijer/atelier") return "ghcr.io/lucasmeijer/atelier-workspace";
  return `${appImage}-workspace`;
}

function workspaceHashTag(metadataTag: string): string {
  const marker = "atelier-workspace:";
  if (!metadataTag.startsWith(marker)) throw new Error(`unexpected workspace image metadata tag: ${metadataTag}`);
  return metadataTag.slice(marker.length);
}

function builderNameForHost(host: string): string {
  return host.replaceAll(/[^A-Za-z0-9_.-]/g, "-").replaceAll(/^[.-]+/g, "") || "remote";
}

function builderName(options: Options): string | undefined {
  return options.builderHost ? builderNameForHost(options.builderHost) : undefined;
}

function ensureBuilder(options: Options): void {
  if (!options.builderHost) return;
  const name = builderName(options)!;
  if (maybeRun(["docker", "buildx", "inspect", "--bootstrap", name])) return;
  run(["docker", "buildx", "create", "--name", name, "--driver", "docker-container", `ssh://${options.builderHost}`], { inherit: true });
  run(["docker", "buildx", "inspect", "--bootstrap", name], { inherit: true });
}

function dockerBuildCommand(options: Options): string[] {
  const hasMultiplePlatforms = Boolean(options.platform?.includes(","));
  if (hasMultiplePlatforms && !options.push) fail("multi-platform builds require --push");
  const name = builderName(options);
  if (options.platform || options.push || name) {
    return [
      "docker", "buildx", "build",
      ...(name ? ["--builder", name] : []),
      ...(options.push ? ["--push", "--provenance=false"] : ["--load"]),
    ];
  }
  return ["docker", "build"];
}

const options = parseArgs(process.argv.slice(2));
ensureBuilder(options);
const tags = options.tags.length > 0 ? options.tags.map(sanitizeTag) : [defaultTag()];
if (options.latest) tags.push("latest");
if (options.stable) tags.push("stable");
const uniqueTags = [...new Set(tags)];
const imageRefs = uniqueTags.map((tag) => `${options.image}:${tag}`);

run(["bun", "packages/workspace-image/scripts/build-context.mjs", workspaceContextDir]);
const workspaceMetadata = JSON.parse(await Bun.file(`${workspaceContextDir}/metadata.json`).text()) as WorkspaceImageMetadata;
const workspaceTag = workspaceHashTag(workspaceMetadata.tag);
const workspaceRepo = workspaceImageRepository(options.image);
const defaultWorkspaceImageRef = `${workspaceRepo}:${workspaceTag}`;

const workspaceBuildCommand = dockerBuildCommand(options);
workspaceBuildCommand.push("--tag", defaultWorkspaceImageRef);
if (options.platform) workspaceBuildCommand.push("--platform", options.platform);
if (options.noCache) workspaceBuildCommand.push("--no-cache");
if (options.progress) workspaceBuildCommand.push("--progress", options.progress);
workspaceBuildCommand.push("--file", `${workspaceContextDir}/Dockerfile`, workspaceContextDir);

const shouldBuildWorkspace = options.forceWorkspace || options.noCache || !workspaceImageExists(defaultWorkspaceImageRef, options);
if (shouldBuildWorkspace) {
  console.log(`${options.push ? "Publishing" : "Building"} default Atelier workspace image:`);
  console.log(`  ${defaultWorkspaceImageRef}`);
  console.log();
} else {
  console.log(`Reusing existing default Atelier workspace image:`);
  console.log(`  ${defaultWorkspaceImageRef}`);
  console.log(`  pass --workspace to rebuild it`);
}

const defaultBuildArgs = [
  `ATELIER_COMMIT_ID=${gitCommitId()}`,
  `ATELIER_COMMIT_DESCRIPTION=${gitCommitDescription()}`,
  `ATELIER_DEFAULT_WORKSPACE_IMAGE=${defaultWorkspaceImageRef}`,
  // Self-update compatibility is the installer/runtime contract required for
  // Atelier's smooth in-app Docker replacement flow. Change this value when a
  // release needs users to rerun the installer instead of applying the update
  // from inside Atelier. Use a human-readable value and bump the suffix, e.g.
  // "tailscale-serve-localhost-v3", when the contract changes again.
  "ATELIER_SELF_UPDATE_COMPATIBILITY=workspace-carriers-v3",
];
const allBuildArgs = [...defaultBuildArgs, ...options.buildArgs];

const buildCommand = dockerBuildCommand(options);
for (const ref of imageRefs) buildCommand.push("--tag", ref);
for (const buildArg of allBuildArgs) buildCommand.push("--build-arg", buildArg);
if (options.platform) buildCommand.push("--platform", options.platform);
if (options.noCache) buildCommand.push("--no-cache");
if (options.progress) buildCommand.push("--progress", options.progress);
buildCommand.push("--file", "apps/web/Dockerfile", ".");

console.log();
console.log(`${options.push ? "Publishing" : "Building"} Atelier image:`);
for (const ref of imageRefs) console.log(`  ${ref}`);
console.log(`  default workspace image: ${defaultWorkspaceImageRef}`);
console.log();
if (shouldBuildWorkspace) {
  await Promise.all([runInherited(workspaceBuildCommand), runInherited(buildCommand)]);
} else {
  run(buildCommand, { inherit: true });
}

console.log();
console.log(options.push ? "Published:" : "Built:");
console.log(`  ${defaultWorkspaceImageRef}${shouldBuildWorkspace ? "" : " (reused)"}`);
for (const ref of imageRefs) console.log(`  ${ref}`);
