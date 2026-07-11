import { AtelierCoreError } from "./errors.ts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandBufferResult = Omit<CommandResult, "stdout"> & { stdout: Buffer };

function spawnDocker(args: string[], options: { stdin?: string }): Bun.Subprocess<"pipe", "pipe", "pipe"> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["docker", ...args], {
      env: { ...process.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw dockerUnavailable(error);
  }

  if (options.stdin !== undefined) {
    proc.stdin.write(options.stdin);
  }
  proc.stdin.end();
  return proc;
}

function throwIfDockerUnavailable(exitCode: number, stderr: string): void {
  if (exitCode === 127 && /docker/i.test(stderr)) throw dockerUnavailable(stderr);
}

export async function runDocker(args: string[], options: { stdin?: string } = {}): Promise<CommandResult> {
  const proc = spawnDocker(args, options);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  throwIfDockerUnavailable(exitCode, stderr);
  return { exitCode, stdout, stderr };
}

export async function runDockerBuffer(args: string[], options: { stdin?: string } = {}): Promise<CommandBufferResult> {
  const proc = spawnDocker(args, options);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  throwIfDockerUnavailable(exitCode, stderr);
  return { exitCode, stdout: Buffer.from(stdout), stderr };
}

export async function requireDocker(args: string[], options: { stdin?: string } = {}): Promise<CommandResult> {
  const result = await runDocker(args, options);
  if (result.exitCode !== 0) {
    throw new AtelierCoreError("docker_unavailable", result.stderr.trim() || `docker ${args[0] ?? ""} failed`);
  }
  return result;
}

function dockerUnavailable(error: unknown): AtelierCoreError {
  const message = error instanceof Error ? error.message : String(error);
  return new AtelierCoreError("docker_unavailable", message);
}
