import { afterAll, beforeAll, expect } from "bun:test";

export const testNamespace = `test-${crypto.randomUUID()}`;

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface JsonSuccess<T> {
  ok: true;
  result: T;
}

export interface JsonFailure {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type JsonResult<T> = JsonSuccess<T> | JsonFailure;

export interface WorkspaceNewResult {
  id: string;
}

export interface WorkspaceListResult {
  workspaces: Array<{
    id: string;
    title: string | null;
  }>;
}

export interface WorkspaceExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface WorkspaceRepoListResult {
  repos: string[];
}

export interface WorkspaceRepoWorkingTreeStatus {
  stagedFiles: string[];
  addedFiles: string[];
  modifiedFiles: string[];
  removedFiles: string[];
  untrackedFiles: string[];
}

export type WorkspaceRepoMergeabilityResult =
  | { state: "can_push"; ahead: number; behind: number; workingTree: WorkspaceRepoWorkingTreeStatus }
  | { state: "has_conflicts"; ahead: number; behind: number; conflictCount: number; workingTree: WorkspaceRepoWorkingTreeStatus }
  | { state: "fetch_failed"; message: string; workingTree: WorkspaceRepoWorkingTreeStatus }
  | { state: "nothing_to_push"; behind: number; workingTree: WorkspaceRepoWorkingTreeStatus };

export type WorkspaceRepoPushResult =
  | { state: "pushed" }
  | { state: "skipped"; reason: "nothing_to_push" | "has_conflicts" | "fetch_failed" }
  | { state: "failed"; message: string };

export async function runAtelier(args: string[], options: { namespace?: string; dataDir?: string } = {}): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", "tools/atelier/src/main.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ATELIER_NAMESPACE: options.namespace ?? testNamespace,
      ...(options.dataDir ? { ATELIER_DATA_DIR: options.dataDir } : {}),
    },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

export function parseStdoutJson<T>(result: CliResult): JsonResult<T> {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as JsonResult<T>;
}

export function expectSuccess<T>(result: CliResult): T {
  expect(result.exitCode).toBe(0);
  const body = parseStdoutJson<T>(result);
  expect(body.ok).toBe(true);
  if (!body.ok) throw new Error("expected success");
  return body.result;
}

export function expectFailure(result: CliResult): JsonFailure["error"] {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  const body = JSON.parse(result.stderr) as JsonFailure;
  expect(body.ok).toBe(false);
  expect(typeof body.error.code).toBe("string");
  expect(body.error.code.length).toBeGreaterThan(0);
  expect(typeof body.error.message).toBe("string");
  expect(body.error.message.length).toBeGreaterThan(0);
  return body.error;
}

async function docker(args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export async function cleanupNamespace(namespace = testNamespace): Promise<void> {
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

beforeAll(async () => {
  await cleanupNamespace();
});

afterAll(async () => {
  await cleanupNamespace();
});
