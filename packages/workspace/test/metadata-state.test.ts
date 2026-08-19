import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { JsonValue } from "@atelier/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createWorkspaceMetadataState } from "../src/metadata-state.ts";

let dataDir: string;
afterEach(async () => { if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

const numbersSchema = Type.Array(Type.Number());

function parseNumbers(value: JsonValue): number[] {
  return Value.Parse(numbersSchema, value);
}

describe("adapter-owned Workspace metadata state", () => {
  test("writes atomically and restores through a fresh adapter instance", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "atelier-resource-state-"));
    createWorkspaceMetadataState("resource.json", parseNumbers, () => [], { dataDir }).write("workspace-1", [1, 2]);
    expect(createWorkspaceMetadataState("resource.json", parseNumbers, () => [], { dataDir }).read("workspace-1")).toEqual([1, 2]);
  });

  test("rejects malformed stored adapter state", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "atelier-resource-state-"));
    const metadata = join(dataDir, "workspaces", "workspace-1", "metadata");
    await mkdir(metadata, { recursive: true });
    await writeFile(join(metadata, "resource.json"), "{}\n");
    expect(() => createWorkspaceMetadataState("resource.json", parseNumbers, () => [], { dataDir }).read("workspace-1")).toThrow();
  });
});
