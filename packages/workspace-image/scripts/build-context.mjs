#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = process.argv[2];
if (!outDir || process.argv.length > 3) throw new Error("usage: build-context.mjs <output-dir>");
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const packagesDir = join(root, "packages");

function quote(value) { return JSON.stringify(value); }
function dockerEscapeRun(script) { return script.replaceAll("\\", "\\\\").replaceAll("\n", " "); }
function dockerContinuationList(values) {
  const continuation = " " + "\\";
  return values.map((value, index) => `      ${value}${index === values.length - 1 ? "" : continuation}`).join("\n");
}
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

function moduleNameFor(dir) {
  const name = basename(dir);
  return name === "workspace-image" ? "base" : name;
}

async function packageManifests() {
  const manifestPaths = [join(packagesDir, "workspace-image", "workspace-image.json")];
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "workspace-image") continue;
    const path = join(packagesDir, entry.name, "workspace-image.json");
    if (existsSync(path)) manifestPaths.push(path);
  }
  const manifests = [];
  for (const path of manifestPaths) {
    const dir = dirname(path);
    manifests.push({ path, dir, name: moduleNameFor(dir), manifest: await readJson(path), hashPath: relative(root, path) });
  }
  return manifests;
}

const manifests = await packageManifests();

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, "files"), { recursive: true });

const hash = createHash("sha256");
hash.update("atelier-workspace-image-v9\n");
const apt = [];
const env = {};
const moduleNames = [];
const modules = [];

// Keep slow, broadly-shared layers early so small later module changes do not
// force VS Code server/extension installation to run again.
function moduleSortKey(manifest) {
  if (manifest.name === "base") return "00-base";
  if (manifest.name === "vscode") return "01-vscode";
  return `10-${manifest.name}`;
}

manifests.sort((a, b) => moduleSortKey(a).localeCompare(moduleSortKey(b)));

for (const { path, dir, name, manifest, hashPath } of manifests) {
  moduleNames.push(name);
  const moduleCopyInstructions = [];
  const manifestText = await readFile(path, "utf8");
  hash.update(hashPath); hash.update("\0"); hash.update(manifestText); hash.update("\0");
  apt.push(...(manifest.aptPackages ?? []));
  Object.assign(env, manifest.env ?? {});
  for (const file of manifest.files ?? []) {
    const from = join(dir, file.from);
    const rel = `${name}/${file.from.replaceAll(/[^a-zA-Z0-9._/-]/g, "_")}`;
    const dest = join(outDir, "files", rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(from, dest, { recursive: true });
    const proc = Bun.spawnSync(["sh", "-c", `find ${quote(from)} -type f -print0 | sort -z | xargs -0 sha256sum`]);
    hash.update(proc.stdout);
    moduleCopyInstructions.push({ rel: `files/${rel}`, to: file.to, mode: file.mode });
  }
  modules.push({ name, copyInstructions: moduleCopyInstructions, runInstructions: manifest.run ?? [] });
}

const uniqueApt = [...new Set(apt)].sort();
let dockerfile = `# syntax=docker/dockerfile:1\n\nFROM oven/bun:1.3.14 AS bun-dist\n\nFROM ubuntu:26.04\n\nARG DEBIAN_FRONTEND=noninteractive\nLABEL com.atelier.workspace-image.modules=${quote(moduleNames.join(","))}\n\n`;
if (uniqueApt.length) {
  const aptPackages = dockerContinuationList(uniqueApt);
  dockerfile += `RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\\n    apt-get update \\\n && apt-get install -y --no-install-recommends \\\n${aptPackages}\n\n`;
}
dockerfile += `COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun\nCOPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx\nRUN bun --version\n\n`;
for (const module of modules) {
  dockerfile += `# Module: ${module.name}\n`;
  for (const copy of module.copyInstructions) {
    dockerfile += `COPY ${quote(copy.rel)} ${quote(copy.to)}\n`;
    if (copy.mode) dockerfile += `RUN chmod ${quote(copy.mode)} ${quote(copy.to)}\n`;
  }
  if (module.copyInstructions.length) dockerfile += "\n";
  for (const script of module.runInstructions) dockerfile += `RUN ${dockerEscapeRun(script)}\n\n`;
}
if (Object.keys(env).length) dockerfile += `ENV ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" \\\n    ")}\n\n`;
dockerfile += `WORKDIR /work\n`;
await writeFile(join(outDir, "Dockerfile"), dockerfile);
await writeFile(join(outDir, "metadata.json"), JSON.stringify({ tag: `atelier-workspace:${hash.digest("hex").slice(0, 16)}`, modules: moduleNames }, null, 2));
