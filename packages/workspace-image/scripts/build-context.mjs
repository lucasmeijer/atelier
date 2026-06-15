#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: build-context.mjs <output-dir>");
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const packagesDir = join(root, "packages");

function quote(value) { return JSON.stringify(value); }
function dockerEscapeRun(script) { return script.replaceAll("\\", "\\\\").replaceAll("\n", " "); }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

const manifestPaths = [join(packagesDir, "workspace-image", "workspace-image.json")];
for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "workspace-image") continue;
  const path = join(packagesDir, entry.name, "workspace-image.json");
  if (existsSync(path)) manifestPaths.push(path);
}

function moduleNameFor(dir) {
  const name = basename(dir);
  return name === "workspace-image" ? "base" : name;
}

const manifests = [];
for (const path of manifestPaths) {
  const dir = dirname(path);
  manifests.push({ path, dir, name: moduleNameFor(dir), manifest: await readJson(path) });
}
manifests.sort((a, b) => (a.name === "base" ? -1 : b.name === "base" ? 1 : a.name.localeCompare(b.name)));

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, "files"), { recursive: true });

const hash = createHash("sha256");
hash.update("atelier-workspace-image-v2\n");
const apt = [];
const env = {};
const copyInstructions = [];
const runInstructions = [];
const moduleNames = [];

for (const { path, dir, name, manifest } of manifests) {
  moduleNames.push(name);
  const manifestText = await readFile(path, "utf8");
  hash.update(relative(root, path)); hash.update("\0"); hash.update(manifestText); hash.update("\0");
  apt.push(...(manifest.aptPackages ?? []));
  Object.assign(env, manifest.env ?? {});
  for (const file of manifest.files ?? []) {
    const from = join(dir, file.from);
    const rel = `${name}/${file.from.replaceAll(/[^a-zA-Z0-9._/-]/g, "_")}`;
    const dest = join(outDir, "files", rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(from, dest, { recursive: true });
    if ((await Bun.file(from).exists())) {
      const proc = Bun.spawnSync(["sh", "-c", `find ${quote(from)} -type f -print0 | sort -z | xargs -0 sha256sum`]);
      hash.update(proc.stdout);
    }
    copyInstructions.push({ rel: `files/${rel}`, to: file.to, mode: file.mode });
  }
  runInstructions.push(...(manifest.run ?? []));
}

const uniqueApt = [...new Set(apt)].sort();
let dockerfile = `FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04\n\nARG DEBIAN_FRONTEND=noninteractive\nLABEL com.atelier.workspace-image.modules=${quote(moduleNames.join(","))}\n\n`;
if (uniqueApt.length) {
  dockerfile += `RUN apt-get update \\\n && apt-get install -y --no-install-recommends \\\n${uniqueApt.map((pkg) => `      ${pkg} \\\n`).join("")} && rm -rf /var/lib/apt/lists/*\n\n`;
}
for (const copy of copyInstructions) {
  // Keep permission changes in a plain RUN chmod so the generated Dockerfile
  // remains compatible with both legacy builder and BuildKit.
  dockerfile += `COPY ${quote(copy.rel)} ${quote(copy.to)}\n`;
  if (copy.mode) dockerfile += `RUN chmod ${quote(copy.mode)} ${quote(copy.to)}\n`;
}
if (copyInstructions.length) dockerfile += "\n";
for (const script of runInstructions) dockerfile += `RUN ${dockerEscapeRun(script)}\n\n`;
if (Object.keys(env).length) dockerfile += `ENV ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" \\\n    ")}\n\n`;
dockerfile += `WORKDIR /repos\n`;
await writeFile(join(outDir, "Dockerfile"), dockerfile);
await writeFile(join(outDir, "metadata.json"), JSON.stringify({ tag: `atelier-workspace:${hash.digest("hex").slice(0, 16)}`, modules: moduleNames }, null, 2));
