import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSharedLayerStorage, readSharedContentStorage } from "./storage.ts";
import type { DockerRuntimeConnection } from "./runtime-connection.ts";

test("shared storage client reads fresh installation-wide byte stats without requesting GC", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atelier-storage-"));
  const connection: DockerRuntimeConnection = { version: 1, depth: 2, clientId: "a".repeat(24), adminSocket: join(dir, "admin.sock"), socketDirectory: dir, snapshotterRoot: join(dir, "store") };
  let usedBytes = 12_000_000_000;
  let status = 200;
  let malformed = false;
  const requests: string[] = [];
  const gcFailure = { message: "cannot remove layer", at: "2026-09-10T12:00:00Z" };
  const server = Bun.serve({ unix: connection.adminSocket, fetch(request) {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    if (status !== 200) return new Response("unavailable", { status });
    return Response.json({ usedBytes: malformed ? -1 : usedBytes, unusedBytes: 500, totalBytes: usedBytes + 500, targetBytes: 10_000_000_000, measuredAt: "2026-09-10T12:00:01Z", gcFailure });
  } });
  try {
    const first = await readSharedLayerStorage(connection);
    expect(first.usedBytes).toBe(12_000_000_000);
    expect(first.gcFailure).toEqual(gcFailure);
    usedBytes = 1_000;
    expect((await readSharedLayerStorage(connection)).usedBytes).toBe(1_000);
    malformed = true;
    await expect(readSharedLayerStorage(connection)).rejects.toThrow();
    status = 503;
    await expect(readSharedLayerStorage(connection)).rejects.toThrow("503");
    expect(requests).toEqual(Array(4).fill("GET /storage"));
  } finally {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});


test("compressed content measurement reports pins, uploads, policy and durable GC errors without collecting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atelier-content-storage-"));
  const connection: DockerRuntimeConnection = { version: 1, depth: 0, adminSocket: join(dir, "admin.sock"), socketDirectory: dir, snapshotterRoot: join(dir, "store") };
  const stats = { pinnedBytes: 12_000_000_000, reclaimableBytes: 500, ingestBytes: 100, totalBytes: 12_000_000_600, targetBytes: 10_000_000_000, retentionDays: 7, measuredAt: "2026-09-10T12:00:01Z", gcFailure: { message: "delete failed", at: "2026-09-10T12:00:00Z" } };
  const requests: string[] = [];
  let status = 200;
  const server = Bun.serve({ unix: connection.adminSocket, fetch(request) {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return status === 200 ? Response.json(stats) : new Response("unavailable", { status });
  } });
  try {
    expect(await readSharedContentStorage(connection)).toEqual(stats);
    stats.reclaimableBytes = 0;
    expect((await readSharedContentStorage(connection)).reclaimableBytes).toBe(0);
    stats.pinnedBytes = -1;
    await expect(readSharedContentStorage(connection)).rejects.toThrow();
    status = 503;
    await expect(readSharedContentStorage(connection)).rejects.toThrow("503");
    expect(requests).toEqual(Array(4).fill("GET /content/storage"));
  } finally {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
