#!/usr/bin/env bun

export {};

const usage = `Build the Atelier Docker image.

Usage:
  bun run scripts/build-atelier-image.ts [options]

Options:
  --image <name>        Image repository/name (default: ghcr.io/lucasmeijer/atelier)
  --tag <tag>           Tag to apply. May be passed more than once (default: git describe/short sha)
  --latest             Also tag the image as <image>:latest
  --stable             Also tag the image as <image>:stable
  --push               Push the built images instead of only loading them locally
  --platform <value>   Docker platform(s), e.g. linux/amd64 or linux/amd64,linux/arm64
  --no-cache           Build without Docker cache
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
  noCache: boolean;
  progress?: string;
  buildArgs: string[];
}

interface WorkspaceImageMetadata { tag: string }

const workspaceContextDir = await Bun.$`mktemp -d`.text().then((path) => `${path.trim()}/atelier-workspace`);

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
    latest: false,
    stable: false,
    push: false,
    noCache: false,
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
    } else if (arg === "--no-cache") {
      options.noCache = true;
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

function maybeRun(command: string[]): string | undefined {
  try {
    return run(command, { quiet: true });
  } catch {
    return undefined;
  }
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

function imageCreated(): string {
  return new Date().toISOString();
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

function dockerBuildCommand(options: Options): string[] {
  const hasMultiplePlatforms = Boolean(options.platform?.includes(","));
  if (hasMultiplePlatforms && !options.push) fail("multi-platform builds require --push");
  return options.platform || options.push
    ? ["docker", "buildx", "build", options.push ? "--push" : "--load"]
    : ["docker", "build"];
}

const options = parseArgs(process.argv.slice(2));
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

console.log(`${options.push ? "Publishing" : "Building"} default Atelier workspace image:`);
console.log(`  ${defaultWorkspaceImageRef}`);
console.log();
run(workspaceBuildCommand, { inherit: true });

const defaultBuildArgs = [
  `ATELIER_COMMIT_ID=${gitCommitId()}`,
  `ATELIER_COMMIT_DESCRIPTION=${gitCommitDescription()}`,
  `ATELIER_DEFAULT_WORKSPACE_IMAGE=${defaultWorkspaceImageRef}`,
  `ATELIER_IMAGE_CREATED=${imageCreated()}`,
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
run(buildCommand, { inherit: true });

console.log();
console.log(options.push ? "Published:" : "Built:");
console.log(`  ${defaultWorkspaceImageRef}`);
for (const ref of imageRefs) console.log(`  ${ref}`);
