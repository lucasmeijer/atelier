import { Type } from "typebox";
import { Value } from "typebox/value";
import type { DockerRuntimeConnection } from "./runtime-connection.ts";

const bytes = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const usageSchema = Type.Union([Type.Null(), Type.Array(Type.Object({
  size: Type.Integer({ minimum: -1, maximum: Number.MAX_SAFE_INTEGER }),
  inUse: Type.Boolean(),
}))]);
const workersSchema = Type.Array(Type.Object({ gcPolicy: Type.Array(Type.Object({
  all: Type.Boolean(),
  filter: Type.Union([Type.Null(), Type.Array(Type.String())]),
  keepDuration: Type.Integer({ minimum: 0 }),
  reservedSpace: bytes,
  maxUsedSpace: bytes,
  minFreeSpace: bytes,
})) }), { minItems: 1 });

export interface BuildCacheStorage {
  inUseBytes: number;
  reclaimableBytes: number;
  totalBytes: number;
  targetBytes: number | null;
  gcEnabled: boolean;
  measuredAt: string;
}

async function query(socket: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["buildctl", "--addr", `unix://${socket}`, "--timeout", "30", ...args, "--format", "{{json .}}"], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 35_000,
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`BuildKit measurement failed (exit ${code}): ${stderr.trim()}`);
  return stdout;
}

/** Reads BuildKit's cache accounting and effective GC policies; never prunes. */
export async function readBuildCacheStorage(connection: DockerRuntimeConnection): Promise<BuildCacheStorage> {
  const socket = connection.buildServices!.buildkitSocket;
  const [usageResult, workersResult] = await Promise.all([query(socket, ["du"]), query(socket, ["debug", "workers"])]);
  const usage = Value.Parse(usageSchema, JSON.parse(usageResult));
  const workers = Value.Parse(workersSchema, JSON.parse(workersResult));
  let inUseBytes = 0;
  let reclaimableBytes = 0;
  for (const record of usage ?? []) {
    // Like buildctl du, omit unknown (-1) sizes from the totals.
    if (record.size > 0) {
      if (record.inUse) inUseBytes += record.size;
      else reclaimableBytes += record.size;
    }
  }
  const targets = workers.map(worker => {
    // Only unfiltered, age-independent, all-record policies establish an overall target.
    const caps = worker.gcPolicy.filter(policy => policy.all && !policy.filter?.length && policy.keepDuration === 0 && policy.maxUsedSpace > 0)
      .map(policy => Math.max(policy.maxUsedSpace, policy.reservedSpace));
    return caps.length ? Math.min(...caps) : null;
  });
  return {
    inUseBytes, reclaimableBytes, totalBytes: inUseBytes + reclaimableBytes,
    targetBytes: targets.every(target => target !== null) ? targets.reduce<number>((sum, target) => sum + target!, 0) : null,
    gcEnabled: workers.every(worker => worker.gcPolicy.length > 0),
    measuredAt: new Date().toISOString(),
  };
}
