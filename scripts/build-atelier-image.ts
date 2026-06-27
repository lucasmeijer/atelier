#!/usr/bin/env bun

export {};

const usage = `Build the Atelier Docker image.

Usage:
  bun run scripts/build-atelier-image.ts [options]

Options:
  --image <name>        Image repository/name (default: $ATELIER_IMAGE or atelier)
  --tag <tag>           Tag to apply. May be passed more than once (default: git describe/short sha)
  --latest             Also tag the image as <image>:latest
  --push               Push the built image instead of only loading it locally
  --platform <value>   Docker platform(s), e.g. linux/amd64 or linux/amd64,linux/arm64
  --no-cache           Build without Docker cache
  --progress <value>   Docker progress mode (auto, plain, tty, quiet, rawjson)
  --build-arg K=V      Extra Docker build argument. May be passed more than once
  --help               Show this help

Examples:
  bun run image:build
  bun run image:build -- --image ghcr.io/example/atelier --tag v0.1.0 --latest
  bun run image:publish -- --image ghcr.io/example/atelier --tag v0.1.0 --platform linux/amd64,linux/arm64
`;

interface Options {
  image: string;
  tags: string[];
  latest: boolean;
  push: boolean;
  platform?: string;
  noCache: boolean;
  progress?: string;
  buildArgs: string[];
}

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
    image: process.env.ATELIER_IMAGE || "atelier",
    tags: [],
    latest: false,
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

function run(command: string[], options: { quiet?: boolean } = {}): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    if (!options.quiet) {
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

const options = parseArgs(process.argv.slice(2));
const tags = options.tags.length > 0 ? options.tags.map(sanitizeTag) : [defaultTag()];
if (options.latest) tags.push("latest");
const uniqueTags = [...new Set(tags)];

const imageRefs = uniqueTags.map((tag) => `${options.image}:${tag}`);
const defaultBuildArgs = [
  `ATELIER_COMMIT_ID=${gitCommitId()}`,
  `ATELIER_COMMIT_DESCRIPTION=${gitCommitDescription()}`,
];
const allBuildArgs = [...defaultBuildArgs, ...options.buildArgs];

const hasMultiplePlatforms = Boolean(options.platform?.includes(","));
if (hasMultiplePlatforms && !options.push) fail("multi-platform builds require --push");

const buildCommand = options.platform || options.push
  ? [
      "docker", "buildx", "build",
      options.push ? "--push" : "--load",
    ]
  : ["docker", "build"];

for (const ref of imageRefs) buildCommand.push("--tag", ref);
for (const buildArg of allBuildArgs) buildCommand.push("--build-arg", buildArg);
if (options.platform) buildCommand.push("--platform", options.platform);
if (options.noCache) buildCommand.push("--no-cache");
if (options.progress) buildCommand.push("--progress", options.progress);
buildCommand.push("--file", "apps/web/Dockerfile", ".");

console.log(`${options.push ? "Publishing" : "Building"} Atelier image:`);
for (const ref of imageRefs) console.log(`  ${ref}`);
console.log();

const proc = Bun.spawn(buildCommand, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
const exitCode = await proc.exited;
if (exitCode !== 0) process.exit(exitCode);

console.log();
console.log(options.push ? "Published:" : "Built:");
for (const ref of imageRefs) console.log(`  ${ref}`);
