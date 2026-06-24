import { mkdir, rename, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import {
  atelierDataPath,
  dockerHostAtelierDataPath,
  getAtelierRuntimeContext,
} from "@atelier/core";
import type { AtelierRuntimeContext, WorkspaceDockerMount } from "@atelier/core";
import type { WorkspaceModule } from "@atelier/shared";

const docsSourceUrl = new URL("../../../../docs/atelier.md", import.meta.url);
const docsMountPath = "/opt/atelier/docs";
const docsFileName = "atelier.md";

type WorkspacePlanEvents = {
  on(eventName: "workspace_plan_prepare", handler: (event: { plan: { mounts: WorkspaceDockerMount[] } }) => void | Promise<void>): void;
};

async function installReadOnlyFile(sourceUrl: URL, destinationPath: string): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  const content = await Bun.file(sourceUrl).text();
  const tmpPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, content, { mode: 0o444 });
  await chmod(tmpPath, 0o444).catch(() => undefined);
  await rename(tmpPath, destinationPath);
}

async function syncAtelierDocs(runtime?: AtelierRuntimeContext): Promise<{ hostDocsDir: string }> {
  runtime ??= await getAtelierRuntimeContext();
  await installReadOnlyFile(docsSourceUrl, atelierDataPath(runtime, "docs", docsFileName));
  return { hostDocsDir: dockerHostAtelierDataPath(runtime, "docs") };
}

export const workspaceDocsModule: WorkspaceModule = {
  id: "workspace-docs",
  async initialize({ events }) {
    const docs = await syncAtelierDocs();
    (events as WorkspacePlanEvents).on("workspace_plan_prepare", ({ plan }) => {
      if (plan.mounts.some((mount) => mount.target === docsMountPath)) return;
      plan.mounts.push({
        type: "bind",
        source: docs.hostDocsDir,
        target: docsMountPath,
        readonly: true,
      });
    });
  },
};

export const atelierServerModule = workspaceDocsModule;
