import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSharedLayerStorage } from "./storage.ts";
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
