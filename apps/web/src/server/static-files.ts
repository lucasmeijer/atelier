import type { StaticFileContribution } from "@atelier/shared";
import { workspaceModules } from "./workspace-modules.ts";

export type StaticFileEntry = StaticFileContribution;

function workspaceModuleStaticFiles(): Record<string, StaticFileEntry> {
  return Object.fromEntries(workspaceModules.flatMap((module) => Object.entries(module.staticFiles ?? {})));
}

export const clientEntrypoints: Record<string, StaticFileEntry> = {
  "/workspace.js": { url: new URL("../client/workspace.ts", import.meta.url), contentType: "text/javascript; charset=utf-8" },
};

export const fingerprintedStaticFiles: Record<string, StaticFileEntry> = {
  "/favicon.svg": { url: new URL("../../public/favicon.svg", import.meta.url), contentType: "image/svg+xml; charset=utf-8" },
  "/style.css": { url: new URL("../../public/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  ...workspaceModuleStaticFiles(),
};

export const legacyStaticFiles: Record<string, StaticFileEntry> = {
  "/workspace.js": { url: new URL("../../public/workspace.js", import.meta.url), contentType: "text/javascript; charset=utf-8" },
  ...fingerprintedStaticFiles,
};
