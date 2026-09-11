import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isWorkspaceSnapshotterInput, workspaceSnapshotterInputs } from "./snapshotter-inputs.ts";
import { parseWorkspaceImageMetadata } from "../src/metadata.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryRoots: string[] = [];
afterAll(async () => { await Promise.all(temporaryRoots.map((path) => rm(path, { recursive: true, force: true }))); });

async function generateContext(fixture: string) {
  const output = join(fixture, "output");
  const process = Bun.spawnSync(["bun", join(fixture, "packages/workspace-image/scripts/build-context.mjs"), output], { cwd: fixture, stdout: "pipe", stderr: "pipe" });
  if (process.exitCode !== 0) throw new Error(process.stderr.toString());
  return { fixture, output, metadata: await Bun.file(join(output, "metadata.json")).text(), dockerfile: await Bun.file(join(output, "Dockerfile")).text() };
}

async function generateInCheckout() {
  const fixture = await mkdtemp(join(tmpdir(), "atelier-image-context-"));
  temporaryRoots.push(fixture);
  await cp(join(root, "packages"), join(fixture, "packages"), { recursive: true });
  return generateContext(fixture);
}

describe("workspace image content identity", () => {
  test("validates generated metadata before consumers use it", () => {
    expect(parseWorkspaceImageMetadata({ tag: "atelier-workspace:abc", modules: ["base"] })).toEqual({
      tag: "atelier-workspace:abc",
      modules: ["base"],
    });
    expect(() => parseWorkspaceImageMetadata({ tag: 42, modules: ["base"] })).toThrow();
    expect(() => parseWorkspaceImageMetadata({ tag: "atelier-workspace:abc" })).toThrow();
  });

  test.each([
    ["coordinator source", "packages/docker-snapshotter/internal/workspace/local.go", "snapshotter/internal/workspace/local.go", "//"],
    ["common protocol", "packages/docker-snapshotter/internal/protocol/warm.go", "snapshotter/internal/protocol/warm.go", "//"],
    ["systemd bootstrap script", "packages/workspace-image/rootfs/usr/local/bin/atelier-workspace-init", "files/base/rootfs/usr/local/bin/atelier-workspace-init", "#"],
    ["snapshotter launcher", "packages/workspace-image/rootfs/usr/local/bin/atelier-workspace-start-snapshotter", "files/base/rootfs/usr/local/bin/atelier-workspace-start-snapshotter", "#"],
  ])("%s is packaged and changes the default image identity", async (_name, sourcePath, packagedPath, comment) => {
    const before = await generateInCheckout();
    const source = join(before.fixture, sourcePath);
    await appendFile(source, `\n${comment} image identity probe\n`);
    const after = await generateContext(before.fixture);
    expect(await Bun.file(join(after.output, packagedPath)).text()).toBe(await Bun.file(source).text());
    expect(after.metadata).not.toBe(before.metadata);
  });

  test("shared implementation and integration test changes do not affect the workspace image", async () => {
    const before = await generateInCheckout();
    for (const name of ["main.go", "lineage.go", "content_ownership.go", "gc_test.go", "local_test.go"]) {
      await appendFile(join(before.fixture, "packages/docker-snapshotter", name), "\n// shared-only identity probe\n");
    }
    const after = await generateContext(before.fixture);
    expect(after.metadata).toBe(before.metadata);
    expect(after.dockerfile).toBe(before.dockerfile);
    expect(await Bun.file(join(after.output, "snapshotter/main.go")).exists()).toBe(false);
    expect(await Bun.file(join(after.output, "snapshotter/local_test.go")).exists()).toBe(false);
  });

  test("development watcher uses the same isolated snapshotter inputs as the build", async () => {
    const inputs = await workspaceSnapshotterInputs(join(root, "packages/docker-snapshotter"));
    expect(inputs).toContain("cmd/atelier-workspace-snapshotter/main.go");
    expect(inputs).toContain("internal/workspace/hybrid_test.go");
    expect(inputs).toContain("internal/protocol/warm.go");
    expect(inputs).toContain("internal/process/process.go");
    expect(inputs).toContain("go.mod");
    for (const input of inputs) expect(isWorkspaceSnapshotterInput(input)).toBe(true);
    for (const input of ["main.go", "lineage.go", "local_test.go", "gc_test.go", "internal/shared/new.go"]) {
      expect(inputs).not.toContain(input);
      expect(isWorkspaceSnapshotterInput(input)).toBe(false);
    }
  });

  test("equivalent checkouts at different absolute paths produce identical output", async () => {
    const [left, right] = await Promise.all([generateInCheckout(), generateInCheckout()]);
    expect(left.metadata).toBe(right.metadata);
    expect(left.dockerfile).toBe(right.dockerfile);
    expect(left.dockerfile).toContain("AS snapshotter-build");
    expect(left.dockerfile).toContain("-o /atelier-workspace-snapshotter ./cmd/atelier-workspace-snapshotter");
    expect(left.dockerfile).toContain("COPY --from=snapshotter-build /atelier-workspace-snapshotter /usr/local/bin/atelier-workspace-snapshotter");
  });
});
