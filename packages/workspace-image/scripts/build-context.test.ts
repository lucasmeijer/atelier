import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
    ["systemd bootstrap script", "packages/workspace-image/rootfs/usr/local/bin/atelier-workspace-init", "files/base/rootfs/usr/local/bin/atelier-workspace-init", "#"],
  ])("%s is packaged and changes the default image identity", async (_name, sourcePath, packagedPath, comment) => {
    const before = await generateInCheckout();
    const source = join(before.fixture, sourcePath);
    await appendFile(source, `\n${comment} image identity probe\n`);
    const after = await generateContext(before.fixture);
    expect(await Bun.file(join(after.output, packagedPath)).text()).toBe(await Bun.file(source).text());
    expect(after.metadata).not.toBe(before.metadata);
  });

  test("generated Dockerfile and file permissions participate in identity", async () => {
    const before = await generateInCheckout();
    const generator = join(before.fixture, "packages/workspace-image/scripts/build-context.mjs");
    await writeFile(generator, (await readFile(generator, "utf8")).replace("WORKDIR /work", "WORKDIR /changed-work"));
    const instructionChange = await generateContext(before.fixture);
    expect(instructionChange.metadata).not.toBe(before.metadata);
    await chmod(join(before.fixture, "packages/workspace-image/rootfs/usr/local/bin/chromium"), 0o700);
    const permissionChange = await generateContext(before.fixture);
    expect(permissionChange.metadata).not.toBe(instructionChange.metadata);
  });

  test("equivalent checkouts at different absolute paths produce identical output", async () => {
    const [left, right] = await Promise.all([generateInCheckout(), generateInCheckout()]);
    expect(left.metadata).toBe(right.metadata);
    expect(left.dockerfile).toBe(right.dockerfile);
  });
});

describe("workspace image layer ordering", () => {
  test("installs module dependencies before their setup, after heavyweight tooling", async () => {
    const { dockerfile } = await generateInCheckout();
    const moduleBlock = (name: string) => dockerfile.split(`# Module: ${name}\n`)[1]!.split("# Module:")[0]!.split("# Files independent")[0]!;
    const base = moduleBlock("base");
    expect(base.indexOf("apt-get install")).toBeLessThan(base.indexOf("npm install -g playwright"));
    expect(base).not.toContain("      socat");
    expect(base).not.toContain("      openbox");
    expect(base).not.toContain("      tmux");
    expect(moduleBlock("proxy-egress")).toContain("      socat");
    expect(moduleBlock("workspace-terminal")).toContain("      tmux");
    const desktop = moduleBlock("desktop");
    expect(desktop).toContain("      openbox");
    expect(desktop.indexOf("apt-get install")).toBeLessThan(desktop.indexOf("RUN glib-compile-schemas"));
    expect(dockerfile.indexOf("# Module: base")).toBeLessThan(dockerfile.indexOf("# Module: vscode"));
    expect(dockerfile.indexOf("# Module: vscode")).toBeLessThan(dockerfile.indexOf("# Module: desktop"));
  });

  test("changing feature dependencies preserves preceding build instructions", async () => {
    const before = await generateInCheckout();
    const manifest = join(before.fixture, "packages/proxy-egress/workspace-image.json");
    await writeFile(manifest, JSON.stringify({ aptPackages: ["socat", "strace", "socat"] }));
    const after = await generateContext(before.fixture);
    expect(after.metadata).not.toBe(before.metadata);
    const prefix = (dockerfile: string) => dockerfile.split("# Module: proxy-egress\n")[0];
    expect(prefix(after.dockerfile)).toBe(prefix(before.dockerfile));
    expect(after.dockerfile.match(/      socat/g)).toHaveLength(1);
    expect(after.dockerfile).toContain("      socat \\\n      strace");
  });

  test.each([
    ["packages/workspace-image/rootfs/usr/local/bin/atelier-workspace-init", "files/base/rootfs/usr/local/bin/atelier-workspace-init"],
    ["packages/vscode/workspace-image/rootfs/usr/local/bin/atelier-start-vscode", "files/vscode/workspace-image/rootfs/usr/local/bin/atelier-start-vscode"],
  ])("copies runtime script %s only after module setup", async (sourcePath, packagedPath) => {
    const before = await generateInCheckout();
    const copy = `COPY ${JSON.stringify(packagedPath)}`;
    expect(before.dockerfile.indexOf(copy)).toBeGreaterThan(before.dockerfile.indexOf("# Files independent of module setup"));
    await appendFile(join(before.fixture, sourcePath), "\n# cache boundary probe\n");
    const after = await generateContext(before.fixture);
    expect(after.metadata).not.toBe(before.metadata);
    expect(after.dockerfile.split("LABEL com.atelier.workspace-image.signature=")[0]).toBe(before.dockerfile.split("LABEL com.atelier.workspace-image.signature=")[0]);
    expect(await readFile(join(after.output, packagedPath), "utf8")).toContain("# cache boundary probe");
  });
});
