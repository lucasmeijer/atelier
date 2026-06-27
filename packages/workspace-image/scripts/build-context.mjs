#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = process.argv[2];
let sourceDir = "";
let baseImage = "";
for (let i = 3; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--base-image") {
    baseImage = process.argv[++i] || "";
    if (!baseImage) throw new Error("--base-image requires a value");
  } else if (!sourceDir) {
    sourceDir = arg;
  } else {
    throw new Error(`unexpected argument: ${arg}`);
  }
}
sourceDir ||= process.env.ATELIER_WORKSPACE_SOURCE_PATH || "";
if (!outDir) throw new Error("usage: build-context.mjs <output-dir> [source-dir --base-image <image>]");
if (sourceDir && !baseImage) throw new Error("source-dir requires --base-image");
if (baseImage && !sourceDir) throw new Error("--base-image requires a source-dir");
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const packagesDir = join(root, "packages");

function quote(value) { return JSON.stringify(value); }
function dockerEscapeRun(script) { return script.replaceAll("\\", "\\\\").replaceAll("\n", " "); }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

function moduleNameFor(dir) {
  const name = basename(dir);
  return name === "workspace-image" ? "base" : name;
}

function assertSafeRepoRelativePath(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("repo workspace image file.from must be a non-empty string");
  if (isAbsolute(value)) throw new Error(`repo workspace image file.from must be relative: ${value}`);
  const normalized = normalize(value).replaceAll("\\", "/");
  if (normalized === ".." || normalized.startsWith("../")) throw new Error(`repo workspace image file.from may not escape repository: ${value}`);
  return normalized;
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
    manifests.push({ path, dir, name: moduleNameFor(dir), manifest: await readJson(path), repo: false, hashPath: relative(root, path) });
  }
  return manifests;
}

async function repoManifest() {
  if (!sourceDir) return undefined;
  const path = join(sourceDir, ".atelier", "workspace.json");
  if (!existsSync(path)) return undefined;
  const manifest = await readJson(path);
  if (manifest.version !== undefined && manifest.version !== 1) throw new Error(`unsupported repo workspace image version: ${manifest.version}`);
  return { path, dir: sourceDir, name: "repo", manifest, repo: true, hashPath: relative(sourceDir, path) };
}

const manifests = baseImage ? [] : await packageManifests();
const repo = await repoManifest();
if (baseImage && !repo) throw new Error("--base-image requires .atelier/workspace.json in source-dir");
if (repo) manifests.push(repo);
manifests.sort((a, b) => (a.name === "base" ? -1 : b.name === "base" ? 1 : a.name === "repo" ? 1 : b.name === "repo" ? -1 : a.name.localeCompare(b.name)));

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, "files"), { recursive: true });

const hash = createHash("sha256");
hash.update(baseImage ? "atelier-workspace-image-extension-v1\n" : "atelier-workspace-image-v6\n");
if (baseImage) { hash.update("base-image\0"); hash.update(baseImage); hash.update("\0"); }
const apt = [];
const env = {};
const copyInstructions = [];
const runInstructions = [];
const moduleNames = [];

for (const { path, dir, name, manifest, repo, hashPath } of manifests) {
  moduleNames.push(name);
  const manifestText = await readFile(path, "utf8");
  hash.update(hashPath); hash.update("\0"); hash.update(manifestText); hash.update("\0");
  apt.push(...(manifest.aptPackages ?? []));
  Object.assign(env, manifest.env ?? {});
  for (const file of manifest.files ?? []) {
    const safeFrom = repo ? assertSafeRepoRelativePath(file.from) : file.from;
    const from = join(dir, safeFrom);
    const rel = `${name}/${safeFrom.replaceAll(/[^a-zA-Z0-9._/-]/g, "_")}`;
    const dest = join(outDir, "files", rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(from, dest, { recursive: true });
    const proc = Bun.spawnSync(["sh", "-c", `find ${quote(from)} -type f -print0 | sort -z | xargs -0 sha256sum`]);
    hash.update(proc.stdout);
    copyInstructions.push({ rel: `files/${rel}`, to: file.to, mode: file.mode });
  }
  runInstructions.push(...(manifest.run ?? []));
}

const uniqueApt = [...new Set(apt)].sort();
let dockerfile = baseImage
  ? `FROM ${baseImage}\n\nARG DEBIAN_FRONTEND=noninteractive\nLABEL com.atelier.workspace-image.base=${quote(baseImage)}\nLABEL com.atelier.workspace-image.modules=${quote(moduleNames.join(","))}\n\n`
  : `FROM oven/bun:1.3.14 AS bun-dist\n\nFROM ubuntu:26.04\n\nARG DEBIAN_FRONTEND=noninteractive\nLABEL com.atelier.workspace-image.modules=${quote(moduleNames.join(","))}\n\n`;
if (uniqueApt.length) {
  dockerfile += `RUN apt-get update \\\n && apt-get install -y --no-install-recommends \\\n${uniqueApt.map((pkg) => `      ${pkg} \\\n`).join("")} && rm -rf /var/lib/apt/lists/*\n\n`;
}
if (!baseImage) dockerfile += `COPY --from=bun-dist /usr/local/bin/bun /usr/local/bin/bun\nCOPY --from=bun-dist /usr/local/bin/bunx /usr/local/bin/bunx\nRUN bun --version\n\n`;
for (const copy of copyInstructions) {
  dockerfile += `COPY ${quote(copy.rel)} ${quote(copy.to)}\n`;
  if (copy.mode) dockerfile += `RUN chmod ${quote(copy.mode)} ${quote(copy.to)}\n`;
}
if (copyInstructions.length) dockerfile += "\n";
for (const script of runInstructions) dockerfile += `RUN ${dockerEscapeRun(script)}\n\n`;
if (Object.keys(env).length) dockerfile += `ENV ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" \\\n    ")}\n\n`;
dockerfile += `WORKDIR /work\n`;
await writeFile(join(outDir, "Dockerfile"), dockerfile);
await writeFile(join(outDir, "metadata.json"), JSON.stringify({ tag: `atelier-workspace:${hash.digest("hex").slice(0, 16)}`, modules: moduleNames, baseImage: baseImage || undefined }, null, 2));
