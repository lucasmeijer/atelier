import { AtelierCoreError } from "./errors.ts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runDocker(args: string[], options: { stdin?: string } = {}): Promise<CommandResult> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["docker", ...args], {
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

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode === 127 && /docker/i.test(stderr)) {
    throw dockerUnavailable(stderr);
  }

  return { exitCode, stdout, stderr };
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
