import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { DockerRuntimeConnection } from "./runtime-connection.ts";

const bytes = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const timestamp = Type.String({ format: "date-time" });
const measurementFields = {
  totalBytes: bytes,
  targetBytes: bytes,
  measuredAt: timestamp,
  gcFailure: Type.Optional(Type.Object({ message: Type.String(), at: timestamp })),
};
const sharedLayerStorageSchema = Type.Object({
  usedBytes: bytes,
  unusedBytes: bytes,
  ...measurementFields,
});
export type SharedLayerStorage = Static<typeof sharedLayerStorageSchema>;

const sharedContentStorageSchema = Type.Object({
  pinnedBytes: bytes,
  reclaimableBytes: bytes,
  ingestBytes: bytes,
  ...measurementFields,
  retentionDays: Type.Integer({ minimum: 1 }),
});
export type SharedContentStorage = Static<typeof sharedContentStorageSchema>;

/** Installation-wide, freshly measured unpacked layers; never triggers GC. */
export async function readSharedLayerStorage(connection: DockerRuntimeConnection): Promise<SharedLayerStorage> {
  return readStorage(connection, "/storage", sharedLayerStorageSchema);
}

/** Fresh compressed-content accounting, including uploads; never triggers GC. */
export async function readSharedContentStorage(connection: DockerRuntimeConnection): Promise<SharedContentStorage> {
  return readStorage(connection, "/content/storage", sharedContentStorageSchema);
}

async function readStorage<T extends TSchema>(connection: DockerRuntimeConnection, path: string, schema: T): Promise<Static<T>> {
  const response = await fetch(`http://localhost${path}`, {
    unix: connection.adminSocket,
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Shared storage measurement failed (${path}, ${response.status}): ${await response.text()}`);
  return Value.Parse(schema, await response.json());
}
