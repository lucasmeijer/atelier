import type { StaticFileContribution } from "@atelier/shared";
import { workspaceProvisioningStaticFiles } from "@atelier/workspace/server/provisioning";
import { workspaceModules } from "./workspace-modules.ts";

export type StaticFileEntry = StaticFileContribution;
interface StaticFileRegistry {
  [path: string]: StaticFileEntry;
}

function workspaceModuleStaticFiles(): Record<string, StaticFileEntry> {
  return Object.fromEntries(workspaceModules.flatMap((module) => Object.entries(module.staticFiles ?? {})));
}

export const clientEntrypoints = {
  "/workspace.js": { url: new URL("../client/workspace.ts", import.meta.url), contentType: "text/javascript; charset=utf-8" },
  "/design-system.js": { url: new URL("../client/design-system-catalogue.ts", import.meta.url), contentType: "text/javascript; charset=utf-8" },
} satisfies Record<string, StaticFileEntry>;

export const fingerprintedStaticFiles: StaticFileRegistry = {
  "/favicon.ico": { url: new URL("../../public/favicon.ico", import.meta.url), contentType: "image/x-icon" },
  "/favicon-32x32.png": { url: new URL("../../public/favicon-32x32.png", import.meta.url), contentType: "image/png" },
  "/favicon-16x16.png": { url: new URL("../../public/favicon-16x16.png", import.meta.url), contentType: "image/png" },
  "/apple-touch-icon.png": { url: new URL("../../public/apple-touch-icon.png", import.meta.url), contentType: "image/png" },
  "/icon-192.png": { url: new URL("../../public/icon-192.png", import.meta.url), contentType: "image/png" },
  "/icon-512.png": { url: new URL("../../public/icon-512.png", import.meta.url), contentType: "image/png" },
  "/manifest.webmanifest": { url: new URL("../../public/manifest.webmanifest", import.meta.url), contentType: "application/manifest+json; charset=utf-8" },
  "/service-worker.js": { url: new URL("../client/service-worker.js", import.meta.url), contentType: "text/javascript; charset=utf-8" },
  "/design-system.css": { url: new URL("../../public/design-system.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/action-item.css": { url: new URL("../../../../packages/design-system/src/action-item/action-item.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/activity-button.css": { url: new URL("../../../../packages/design-system/src/activity-button/activity-button.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/copy-button.css": { url: new URL("../../../../packages/design-system/src/copy-button/copy-button.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/destructive-confirmation.css": { url: new URL("../../../../packages/design-system/src/destructive-confirmation/destructive-confirmation.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/icons.css": { url: new URL("../../../../packages/design-system/src/icons/icons.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/perimeter-button.css": { url: new URL("../../../../packages/design-system/src/perimeter-button/perimeter-button.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/progress-button.css": { url: new URL("../../../../packages/design-system/src/progress-button/progress-button.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/transient-feedback.css": { url: new URL("../../../../packages/design-system/src/transient-feedback/transient-feedback.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/toggle.css": { url: new URL("../../../../packages/design-system/src/toggle/toggle.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/fonts/jetbrains-mono-latin-400-normal.woff2": { url: new URL(import.meta.resolve("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2")), contentType: "font/woff2" },
  "/style.css": { url: new URL("../../public/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  ...workspaceProvisioningStaticFiles,
  ...workspaceModuleStaticFiles(),
};

export const legacyStaticFiles: StaticFileRegistry = {
  "/workspace.js": { url: new URL("../../public/workspace.js", import.meta.url), contentType: "text/javascript; charset=utf-8" },
  "/design-system-catalogue.html": { url: new URL("../../public/design-system-catalogue.html", import.meta.url), contentType: "text/html; charset=utf-8" },
  ...fingerprintedStaticFiles,
};
