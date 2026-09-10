import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { DockerRuntimeConnection } from "./runtime-connection.ts";

const bytes = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const timestamp = Type.String({ format: "date-time" });
const sharedLayerStorageSchema = Type.Object({
  usedBytes: bytes,
  unusedBytes: bytes,
  totalBytes: bytes,
  targetBytes: bytes,
  measuredAt: timestamp,
  gcFailure: Type.Optional(Type.Object({ message: Type.String(), at: timestamp })),
});
export type SharedLayerStorage = Static<typeof sharedLayerStorageSchema>;

/** Installation-wide, freshly measured unpacked layers; never triggers GC. */
export async function readSharedLayerStorage(connection: DockerRuntimeConnection): Promise<SharedLayerStorage> {
  const response = await fetch("http://localhost/storage", {
    unix: connection.adminSocket,
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Shared image storage measurement failed (${response.status}): ${await response.text()}`);
  return Value.Parse(sharedLayerStorageSchema, await response.json());
}
