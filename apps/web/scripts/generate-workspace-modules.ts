import { readdir, readFile, writeFile } from "node:fs/promises";

interface PackageJson {
  name?: string;
  exports?: Record<string, unknown>;
}

interface DiscoveredModule {
  packageName: string;
  exportName: "atelierClientModule" | "atelierServerModule";
}

const root = new URL("../../../", import.meta.url);
const packagesDir = new URL("packages/", root);
const clientOutputUrl = new URL("../src/client/workspace-client-modules.generated.ts", import.meta.url);
const serverOutputUrl = new URL("../src/server/workspace-modules.generated.ts", import.meta.url);

function disabledPackageNames(): Set<string> {
  const disabled = new Set<string>();
  for (const name of (process.env.ATELIER_DISABLED_WORKSPACE_MODULES ?? "").split(",")) {
    const trimmed = name.trim();
    if (trimmed) disabled.add(trimmed);
  }
  return disabled;
}

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

async function fileText(url: URL): Promise<string | undefined> {
  try {
    return await readFile(url, "utf8");
  } catch {
    return undefined;
  }
}

function hasExport(manifest: PackageJson, subpath: "./client" | "./server"): boolean {
  return subpath in (manifest.exports ?? {});
}

function exportsName(source: string, exportName: string): boolean {
  return new RegExp(`\\b${exportName}\\b`).test(source);
}

async function discoverModules(subpath: "client" | "server", exportName: DiscoveredModule["exportName"]): Promise<DiscoveredModule[]> {
  const packages = await readdir(packagesDir, { withFileTypes: true });
  const disabled = disabledPackageNames();
  const modules: DiscoveredModule[] = [];

  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    const packageJsonUrl = new URL(`${entry.name}/package.json`, packagesDir);
    let manifest: PackageJson;
    try {
      manifest = await readJson<PackageJson>(packageJsonUrl);
    } catch {
      continue;
    }
    if (!manifest.name || disabled.has(manifest.name) || !hasExport(manifest, `./${subpath}`)) continue;

    const index = await fileText(new URL(`${entry.name}/src/${subpath}/index.ts`, packagesDir));
    if (!index || !exportsName(index, exportName)) continue;

    modules.push({ packageName: manifest.name, exportName });
  }

  return modules.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

function renderGeneratedModules(options: {
  modules: DiscoveredModule[];
  subpath: "client" | "server";
  typeName: "WorkspaceClientModule" | "WorkspaceModule";
  constName: "workspaceClientModules" | "workspaceModules";
}): string {
  const imports = options.modules
    .map((module, index) => `import { ${module.exportName} as ${options.subpath}Module${index} } from "${module.packageName}/${options.subpath}";`)
    .join("\n");
  const list = options.modules.map((_, index) => `  ${options.subpath}Module${index},`).join("\n");
  const prefix = imports ? `${imports}\n` : "";
  return `${prefix}import type { ${options.typeName} } from "@atelier/shared";\n\nexport const ${options.constName}: ${options.typeName}[] = [\n${list}\n];\n`;
}

const clientModules = await discoverModules("client", "atelierClientModule");
const serverModules = await discoverModules("server", "atelierServerModule");

await writeFile(clientOutputUrl, renderGeneratedModules({
  modules: clientModules,
  subpath: "client",
  typeName: "WorkspaceClientModule",
  constName: "workspaceClientModules",
}));

await writeFile(serverOutputUrl, renderGeneratedModules({
  modules: serverModules,
  subpath: "server",
  typeName: "WorkspaceModule",
  constName: "workspaceModules",
}));
