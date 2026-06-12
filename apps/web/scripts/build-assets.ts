import { mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { terminalStaticFiles } from "../../../packages/terminal/src/server/static.ts";

const publicDir = new URL("../public/", import.meta.url);
const assetsDir = new URL("../public/assets/", import.meta.url);
const manifestUrl = new URL("../public/assets-manifest.json", import.meta.url);

type Manifest = Record<string, string>;

const manifest: Manifest = {};

function contentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function fingerprintedPath(logicalPath: string, content: string | Uint8Array): string {
  const extension = extname(logicalPath);
  const name = basename(logicalPath, extension);
  return `/assets/${name}-${contentHash(content)}${extension}`;
}

async function copyTextAsset(logicalPath: string, source: URL, transform?: (content: string) => string): Promise<void> {
  const original = await Bun.file(source).text();
  const content = transform ? transform(original) : original;
  const publicPath = fingerprintedPath(logicalPath, content);
  await Bun.write(new URL(`.${publicPath}`, publicDir), content);
  manifest[logicalPath] = publicPath;
}

async function copyBinaryAsset(logicalPath: string, source: URL): Promise<void> {
  const content = new Uint8Array(await Bun.file(source).arrayBuffer());
  const publicPath = fingerprintedPath(logicalPath, content);
  await Bun.write(new URL(`.${publicPath}`, publicDir), content);
  manifest[logicalPath] = publicPath;
}

await rm(assetsDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });

const build = await Bun.build({
  entrypoints: [new URL("../src/client/workspace.ts", import.meta.url).pathname],
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

const workspaceOutput = build.outputs.find((output) => basename(output.path).startsWith("workspace-") && output.path.endsWith(".js"));
if (!workspaceOutput) throw new Error("could not find built workspace.js output");
manifest["/workspace.js"] = `/assets/${basename(workspaceOutput.path)}`;

await copyTextAsset("/style.css", new URL("../public/style.css", import.meta.url));
await copyTextAsset("/agent.css", new URL("../../../packages/agent/src/client/style.css", import.meta.url));
await copyTextAsset("/browser.css", new URL("../../../packages/browser/src/client/style.css", import.meta.url));
await copyTextAsset("/vscode.css", new URL("../../../packages/vscode/src/client/style.css", import.meta.url));
await copyTextAsset("/xterm.css", terminalStaticFiles["/xterm.css"].url);
await copyBinaryAsset("/fonts/jetbrains-mono-latin-300-normal.woff2", terminalStaticFiles["/fonts/jetbrains-mono-latin-300-normal.woff2"].url);
await copyTextAsset("/terminal.css", new URL("../../../packages/terminal/src/client/style.css", import.meta.url), (content) => {
  return content
    .replaceAll('url("/xterm.css")', `url("${manifest["/xterm.css"]}")`)
    .replaceAll('url("/fonts/jetbrains-mono-latin-300-normal.woff2")', `url("${manifest["/fonts/jetbrains-mono-latin-300-normal.woff2"]}")`);
});

await Bun.write(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);

for (const [logicalPath, publicPath] of Object.entries(manifest).sort()) {
  console.log(`${logicalPath} -> ${publicPath}`);
}
