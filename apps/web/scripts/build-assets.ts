import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { StaticFileEntry } from "../src/server/static-files.ts";

await import("./generate-workspace-modules.ts");
const { clientEntrypoints, fingerprintedStaticFiles } = await import("../src/server/static-files.ts");

const publicDir = new URL("../public/", import.meta.url);
const assetsDir = new URL("../public/assets/", import.meta.url);
const manifestUrl = new URL("../public/assets-manifest.json", import.meta.url);
const maxCssManifestPasses = 10;

type Manifest = Record<string, string>;

type StaticFileRecord = [logicalPath: string, entry: StaticFileEntry];

const manifest: Manifest = {};

function contentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function fingerprintedPath(logicalPath: string, content: string | Uint8Array): string {
  const extension = extname(logicalPath);
  const name = basename(logicalPath, extension);
  return `/assets/${name}-${contentHash(content)}${extension}`;
}

function isCss(entry: StaticFileEntry): boolean {
  return entry.contentType.toLowerCase().startsWith("text/css");
}

function rewriteAssetReferences(content: string, assetManifest: Manifest): string {
  let next = content;
  for (const [logicalPath, publicPath] of Object.entries(assetManifest).sort((a, b) => b[0].length - a[0].length)) {
    next = next
      .replaceAll(`url("${logicalPath}")`, `url("${publicPath}")`)
      .replaceAll(`url('${logicalPath}')`, `url('${publicPath}')`)
      .replaceAll(`url(${logicalPath})`, `url(${publicPath})`)
      .replaceAll(`@import "${logicalPath}"`, `@import "${publicPath}"`)
      .replaceAll(`@import '${logicalPath}'`, `@import '${publicPath}'`);
  }
  return next;
}

async function buildClientEntrypoints(): Promise<void> {
  for (const [logicalPath, entry] of Object.entries(clientEntrypoints)) {
    const build = await Bun.build({
      entrypoints: [entry.url.pathname],
      outdir: assetsDir.pathname,
      format: "esm",
      target: "browser",
      naming: {
        entry: "[name]-[hash].[ext]",
        chunk: "[name]-[hash].[ext]",
        asset: "[name]-[hash].[ext]",
      },
    });

    if (!build.success) {
      for (const log of build.logs) console.error(log);
      process.exit(1);
    }

    const entryExtension = extname(logicalPath);
    const outputs = build.outputs.filter((output) => extname(output.path) === entryExtension);
    if (outputs.length !== 1) {
      throw new Error(`expected exactly one ${entryExtension} output for ${logicalPath}, got ${outputs.length}`);
    }
    manifest[logicalPath] = `/assets/${basename(outputs[0].path)}`;
  }
}

async function copyBinaryAsset(logicalPath: string, source: URL): Promise<void> {
  const content = new Uint8Array(await Bun.file(source).arrayBuffer());
  const publicPath = fingerprintedPath(logicalPath, content);
  await Bun.write(new URL(`.${publicPath}`, publicDir), content);
  manifest[logicalPath] = publicPath;
}

async function fingerprintCssAssets(cssFiles: StaticFileRecord[]): Promise<Map<string, string>> {
  const cssSources = new Map<string, string>();
  for (const [logicalPath, entry] of cssFiles) {
    const source = await Bun.file(entry.url).text();
    cssSources.set(logicalPath, source);
    manifest[logicalPath] = fingerprintedPath(logicalPath, source);
  }

  const rendered = new Map<string, string>();
  for (let pass = 0; pass < maxCssManifestPasses; pass += 1) {
    let changed = false;
    for (const [logicalPath, source] of cssSources) {
      const content = rewriteAssetReferences(source, manifest);
      rendered.set(logicalPath, content);
      const publicPath = fingerprintedPath(logicalPath, content);
      if (manifest[logicalPath] !== publicPath) {
        manifest[logicalPath] = publicPath;
        changed = true;
      }
    }
    if (!changed) return rendered;
  }

  throw new Error(`CSS asset manifest did not stabilize after ${maxCssManifestPasses} passes`);
}

await rm(assetsDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });

await buildClientEntrypoints();

const staticFiles = Object.entries(fingerprintedStaticFiles).sort(([a], [b]) => a.localeCompare(b)) as StaticFileRecord[];
const cssFiles = staticFiles.filter(([, entry]) => isCss(entry));
const nonCssFiles = staticFiles.filter(([, entry]) => !isCss(entry));

for (const [logicalPath, entry] of nonCssFiles) {
  await copyBinaryAsset(logicalPath, entry.url);
}

const cssAssets = await fingerprintCssAssets(cssFiles);
for (const [logicalPath, content] of cssAssets) {
  await Bun.write(new URL(`.${manifest[logicalPath]}`, publicDir), content);
}

await Bun.write(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);

for (const [logicalPath, publicPath] of Object.entries(manifest).sort()) {
  console.log(`${logicalPath} -> ${publicPath}`);
}
