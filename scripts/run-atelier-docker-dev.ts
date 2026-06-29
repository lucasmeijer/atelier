#!/usr/bin/env bun

export {};

import { homedir, platform } from "node:os";
import { join } from "node:path";

const usage = `Build and run Atelier in Docker for local development. On Linux the container uses host networking.

Usage:
  bun run docker:dev [options]

Options:
  --image <name>       Image repository/name (default: atelier)
  --tag <tag>          Image tag to build/run (default: latest)
  --name <name>        Container name (default: atelier)
  --port <port>        Host port bound to container port 3000 (default: 3000)
  --bind <address>     Host address to bind (default: all interfaces)
  --data-dir <path>    Host Atelier data dir (default: platform Atelier data dir)
  --no-build           Skip image build and run the existing image
  --detach             Start in the background instead of attaching stdout/stderr
  --help               Show this help

Examples:
  bun run docker:dev
  bun run docker:dev -- --bind 127.0.0.1 --port 3000
  bun run docker:dev -- --bind "$(tailscale ip -4)" --port 80
`;

interface Options {
  image: string;
  tag: string;
  name: string;
  port: string;
  bind?: string;
  dataDir: string;
  build: boolean;
  detach: boolean;
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

function defaultDataDir(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "atelier");
  if (platform() === "linux") return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "atelier");
  return "/var/lib/atelier";
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    image: "atelier",
    tag: "latest",
    name: "atelier",
    port: "3000",
    dataDir: defaultDataDir(),
    build: true,
    detach: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    } else if (arg === "--image") {
      options.image = takeValue(args, i, arg);
      i++;
    } else if (arg === "--tag") {
      options.tag = takeValue(args, i, arg);
      i++;
    } else if (arg === "--name") {
      options.name = takeValue(args, i, arg);
      i++;
    } else if (arg === "--port") {
      options.port = takeValue(args, i, arg);
      i++;
    } else if (arg === "--bind") {
      options.bind = takeValue(args, i, arg);
      i++;
    } else if (arg === "--data-dir") {
      options.dataDir = takeValue(args, i, arg);
      i++;
    } else if (arg === "--no-build") {
      options.build = false;
    } else if (arg === "--detach") {
      options.detach = true;
    } else {
      fail(`unknown option: ${arg}`);
    }
  }

  return options;
}

function run(command: string[], options: { stdout?: "pipe" | "inherit"; allowFailure?: boolean } = {}): string {
  const result = Bun.spawnSync(command, {
    stdout: options.stdout ?? "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  if (result.exitCode !== 0 && !options.allowFailure) throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}`);
  return result.stdout ? result.stdout.toString().trim() : "";
}

function dockerOutput(args: string[]): string {
  return run(["docker", ...args], { stdout: "pipe" });
}

function containerIdsForFilter(filter: string): string[] {
  const output = dockerOutput(["ps", "-aq", "--filter", filter]);
  return output.split(/\s+/).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const options = parseArgs(process.argv.slice(2));
const imageRef = `${options.image}:${options.tag}`;
const useHostNetwork = platform() === "linux";
const publish = options.bind ? `${options.bind}:${options.port}:3000` : `${options.port}:3000`;
const proxyPublish = options.bind ? `${options.bind}:41000-41999:41000-41999` : "41000-41999:41000-41999";

const existing = unique([
  ...containerIdsForFilter(`name=^/${options.name}$`),
  ...containerIdsForFilter("label=com.atelier.type=server"),
  ...containerIdsForFilter(`ancestor=${imageRef}`),
]);

if (existing.length > 0) {
  console.log(`Stopping existing Atelier container(s): ${existing.join(", ")}`);
  run(["docker", "rm", "-f", ...existing]);
}

if (options.build) {
  run(["bun", "run", "scripts/build-atelier-image.ts", "--image", options.image, "--tag", options.tag]);
}

run(["mkdir", "-p", options.dataDir]);

const runArgs = [
  "run",
  ...(options.detach ? ["-d"] : ["--rm", "-i", ...(process.stdout.isTTY ? ["-t"] : [])]),
  "--name", options.name,
  "--label", "com.atelier.type=server",
  "--init",
  ...(useHostNetwork ? ["--network", "host"] : ["-p", publish, "-p", proxyPublish]),
  "-v", "/var/run/docker.sock:/var/run/docker.sock",
  "--mount", `type=bind,src=${options.dataDir},dst=/data/atelier`,
  "--env", "ATELIER_DATA_DIR=/data/atelier",
  "--env", `ATELIER_DOCKER_HOST_DATA_DIR=${options.dataDir}`,
  ...(useHostNetwork ? ["--env", `PORT=${options.port}`, ...(options.bind ? ["--env", `HOST=${options.bind}`] : [])] : []),
  imageRef,
];

console.log(`Starting Atelier container ${options.name}`);
console.log(`URL: http://${options.bind || "127.0.0.1"}:${options.port}`);
console.log(`Data: ${options.dataDir}`);

if (options.detach) {
  const containerId = dockerOutput(runArgs);
  console.log(`Started detached container ${options.name} (${containerId.slice(0, 12)})`);
  console.log(`Logs: docker logs -f ${options.name}`);
} else {
  console.log("Attached to container stdout/stderr. Press Ctrl-C to stop and remove the container.");
  run(["docker", ...runArgs]);
}
