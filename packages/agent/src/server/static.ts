import { observableTerminalStaticFiles } from "@atelier/observable-terminal/server";

export const agentStaticFiles = {
  "/agent.css": { url: new URL("../client/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  ...observableTerminalStaticFiles,
} as const;
