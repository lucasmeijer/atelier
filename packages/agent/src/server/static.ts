import { observableTerminalStaticFiles } from "@atelier/observable-terminal/server";

export const agentStaticFiles = {
  "/agent.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/agent-tree.css": { url: new URL("../client/tree.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  ...observableTerminalStaticFiles,
} as const;
