export interface TestCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function createTestNamespace(prefix = "test"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function docker(args: string[]): Promise<TestCommandResult> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export async function cleanupNamespace(namespace: string): Promise<void> {
  const listed = await docker([
    "ps",
    "-aq",
    "--filter",
    "label=com.atelier.type=workspace",
    "--filter",
    `label=com.atelier.namespace=${namespace}`,
  ]);

  if (listed.exitCode !== 0) return;

  const containerIds = listed.stdout.trim().split(/\s+/).filter(Boolean);
  if (containerIds.length === 0) return;

  await docker(["rm", "-f", ...containerIds]);
}
