import { agentStaticFiles } from "@atelier/agent/server";
import { browserStaticFiles } from "@atelier/browser/server";
import { terminalStaticFiles } from "@atelier/terminal/server";
import { vscodeStaticFiles } from "@atelier/vscode/server";

export interface StaticFileEntry {
  url: URL;
  contentType: string;
}

export const clientEntrypoints: Record<string, StaticFileEntry> = {
  "/workspace.js": { url: new URL("../client/workspace.ts", import.meta.url), contentType: "text/javascript; charset=utf-8" },
};

export const fingerprintedStaticFiles: Record<string, StaticFileEntry> = {
  "/style.css": { url: new URL("../../public/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  ...terminalStaticFiles,
  ...agentStaticFiles,
  ...vscodeStaticFiles,
  ...browserStaticFiles,
};

export const legacyStaticFiles: Record<string, StaticFileEntry> = {
  "/workspace.js": { url: new URL("../../public/workspace.js", import.meta.url), contentType: "text/javascript; charset=utf-8" },
  ...fingerprintedStaticFiles,
};
