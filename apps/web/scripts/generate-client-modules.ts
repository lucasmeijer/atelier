import { readdir, readFile, writeFile } from "node:fs/promises";

interface PackageJson {
  name?: string;
  atelier?: {
    clientModule?: string;
    clientModuleOrder?: number;
  };
}

const root = new URL("../../../", import.meta.url);
const packagesDir = new URL("packages/", root);
const outputUrl = new URL("../src/client/workspace-client-modules.generated.ts", import.meta.url);

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

const packages = await readdir(packagesDir, { withFileTypes: true });
const modules: Array<{ packageName: string; exportName: string; order: number }> = [];

for (const entry of packages) {
  if (!entry.isDirectory()) continue;
  const packageJsonUrl = new URL(`${entry.name}/package.json`, packagesDir);
  let manifest: PackageJson;
  try {
    manifest = await readJson<PackageJson>(packageJsonUrl);
  } catch {
    continue;
  }
  if (!manifest.name || !manifest.atelier?.clientModule) continue;
  modules.push({ packageName: manifest.name, exportName: manifest.atelier.clientModule, order: manifest.atelier.clientModuleOrder ?? 1000 });
}

modules.sort((a, b) => a.order - b.order || a.packageName.localeCompare(b.packageName));

const imports = modules.map((module, index) => `import { ${module.exportName} as clientModule${index} } from "${module.packageName}/client";`).join("\n");
const list = modules.map((_, index) => `  clientModule${index},`).join("\n");

await writeFile(outputUrl, `${imports}\nimport type { WorkspaceClientModule } from "@atelier/shared";\n\nexport const workspaceClientModules: WorkspaceClientModule[] = [\n${list}\n];\n`);
