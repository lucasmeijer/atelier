export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(command: string[], options: { stdin?: string } = {}): Promise<CommandResult> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 127, stdout: "", stderr: message };
  }

  if (options.stdin !== undefined) proc.stdin.write(options.stdin);
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}
