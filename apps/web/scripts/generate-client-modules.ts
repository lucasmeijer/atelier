import { readdir, readFile, writeFile } from "node:fs/promises";

interface PackageJson {
  name?: string;
  exports?: Record<string, unknown>;
}

const root = new URL("../../../", import.meta.url);
const packagesDir = new URL("packages/", root);
const outputUrl = new URL("../src/client/workspace-client-modules.generated.ts", import.meta.url);

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

function clientModuleExportName(packageName: string): string {
  const localName = packageName.split("/").pop() ?? packageName;
  const camel = localName.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());
  return `${camel}ClientModule`;
}

async function fileText(url: URL): Promise<string | undefined> {
  try {
    return await readFile(url, "utf8");
  } catch {
    return undefined;
  }
}

function exportsClientModule(source: string, exportName: string): boolean {
  return new RegExp(`\\b${exportName}\\b`).test(source);
}

const packages = await readdir(packagesDir, { withFileTypes: true });
const modules: Array<{ packageName: string; exportName: string }> = [];

for (const entry of packages) {
  if (!entry.isDirectory()) continue;
  const packageJsonUrl = new URL(`${entry.name}/package.json`, packagesDir);
  let manifest: PackageJson;
  try {
    manifest = await readJson<PackageJson>(packageJsonUrl);
  } catch {
    continue;
  }
  if (!manifest.name || !("./client" in (manifest.exports ?? {}))) continue;

  const exportName = clientModuleExportName(manifest.name);
  const clientIndex = await fileText(new URL(`${entry.name}/src/client/index.ts`, packagesDir));
  if (!clientIndex || !exportsClientModule(clientIndex, exportName)) continue;

  modules.push({ packageName: manifest.name, exportName });
}

modules.sort((a, b) => a.packageName.localeCompare(b.packageName));

const imports = modules.map((module, index) => `import { ${module.exportName} as clientModule${index} } from "${module.packageName}/client";`).join("\n");
const list = modules.map((_, index) => `  clientModule${index},`).join("\n");

await writeFile(outputUrl, `${imports}\nimport type { WorkspaceClientModule } from "@atelier/shared";\n\nexport const workspaceClientModules: WorkspaceClientModule[] = [\n${list}\n];\n`);
