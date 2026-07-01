import type { StaticFileContribution } from "@atelier/shared";
import { workspaceProvisioningStaticFiles } from "@atelier/workspace/server/provisioning";
import { workspaceModules } from "./workspace-modules.ts";

export type StaticFileEntry = StaticFileContribution;

function workspaceModuleStaticFiles(): Record<string, StaticFileEntry> {
  return Object.fromEntries(workspaceModules.flatMap((module) => Object.entries(module.staticFiles ?? {})));
}

export const clientEntrypoints: Record<string, StaticFileEntry> = {
  "/workspace.js": { url: new URL("../client/workspace.ts", import.meta.url), contentType: "text/javascript; charset=utf-8" },
};

export const fingerprintedStaticFiles: Record<string, StaticFileEntry> = {
  "/favicon.ico": { url: new URL("../../public/favicon.ico", import.meta.url), contentType: "image/x-icon" },
  "/favicon-32x32.png": { url: new URL("../../public/favicon-32x32.png", import.meta.url), contentType: "image/png" },
  "/favicon-16x16.png": { url: new URL("../../public/favicon-16x16.png", import.meta.url), contentType: "image/png" },
  "/apple-touch-icon.png": { url: new URL("../../public/apple-touch-icon.png", import.meta.url), contentType: "image/png" },
  "/style.css": { url: new URL("../../public/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  ...workspaceProvisioningStaticFiles,
  ...workspaceModuleStaticFiles(),
};

export const legacyStaticFiles: Record<string, StaticFileEntry> = {
  "/workspace.js": { url: new URL("../../public/workspace.js", import.meta.url), contentType: "text/javascript; charset=utf-8" },
  ...fingerprintedStaticFiles,
};
