import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkspaceImageMetadata } from "../src/metadata.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryRoots: string[] = [];
afterAll(async () => { await Promise.all(temporaryRoots.map((path) => rm(path, { recursive: true, force: true }))); });

async function generateInCheckout(prefix: string): Promise<{ fixture: string; metadata: string; dockerfile: string }> {
  const fixture = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(fixture);
  await cp(join(root, "packages"), join(fixture, "packages"), { recursive: true });
  const output = join(fixture, "output");
  const process = Bun.spawnSync(["bun", join(fixture, "packages/workspace-image/scripts/build-context.mjs"), output], { cwd: fixture, stdout: "pipe", stderr: "pipe" });
  if (process.exitCode !== 0) throw new Error(process.stderr.toString());
  return { fixture, metadata: await Bun.file(join(output, "metadata.json")).text(), dockerfile: await Bun.file(join(output, "Dockerfile")).text() };
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

  test("coordinator source is packaged and changes the default image identity", async () => {
    const before = await generateInCheckout("atelier-coordinator-context-");
    const source = join(before.fixture, "packages/docker-snapshotter/local.go");
    await appendFile(source, "\n// image identity probe\n");
    const output = join(before.fixture, "output");
    const result = Bun.spawnSync(["bun", join(before.fixture, "packages/workspace-image/scripts/build-context.mjs"), output]);
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(output, "snapshotter/local.go")).text()).toBe(await Bun.file(source).text());
    expect(await Bun.file(join(output, "metadata.json")).text()).not.toBe(before.metadata);
  });

  test("systemd bootstrap script is packaged and changes the default image identity", async () => {
    const before = await generateInCheckout("atelier-daemon-context-");
    const relative = "packages/workspace-image/rootfs/usr/local/bin/atelier-workspace-init";
    const source = join(before.fixture, relative);
    await appendFile(source, "\n# image identity probe\n");
    const output = join(before.fixture, "output");
    const result = Bun.spawnSync(["bun", join(before.fixture, "packages/workspace-image/scripts/build-context.mjs"), output]);
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(output, "files/base/rootfs/usr/local/bin/atelier-workspace-init")).text()).toBe(await Bun.file(source).text());
    expect(await Bun.file(join(output, "metadata.json")).text()).not.toBe(before.metadata);
  });

  test("equivalent checkouts at different absolute paths produce identical output", async () => {
    const [left, right] = await Promise.all([generateInCheckout("atelier-context-a-"), generateInCheckout("atelier-context-b-")]);
    expect(left.metadata).toBe(right.metadata);
    expect(left.dockerfile).toBe(right.dockerfile);
    expect(left.dockerfile).toContain("AS snapshotter-build");
    expect(left.dockerfile).toContain("COPY --from=snapshotter-build /atelier-snapshotter /usr/local/bin/atelier-snapshotter");
  });
});
