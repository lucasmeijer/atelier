import type { AtelierEventBus } from "@atelier/core";
import { registerWorkspaceAgentTool } from "@atelier/agent/server";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createWorkspaceTerminal } from "./workspace-terminals.ts";

let registeredAgentTool = false;

function registerTerminalAgentTool(): void {
  if (registeredAgentTool) return;
  registeredAgentTool = true;
  registerWorkspaceAgentTool("create_terminal_tab", (workspaceId, options) => defineTool({
    name: "create_terminal_tab",
    label: "Create terminal tab",
    description: "Create a visible workspace terminal tab. Use this for long-running foreground processes like development servers that the user should be able to watch or interact with. The command runs in /repos by default; after it exits, the terminal drops into bash so output remains visible.",
    parameters: Type.Object({
      command: Type.String({ description: "Command to run in the new terminal tab, for example 'bun run web'" }),
      title: Type.Optional(Type.String({ description: "Optional terminal tab title, for example 'Web server'" })),
      cwd: Type.Optional(Type.String({ description: "Optional working directory under /repos" })),
    }),
    execute: async (_toolCallId: string, params: { command: string; title?: string; cwd?: string }) => {
      const terminal = await createWorkspaceTerminal(workspaceId, {
        command: params.command,
        title: params.title,
        cwd: params.cwd,
        events: options.events,
      });
      return {
        content: [{ type: "text" as const, text: `Created terminal tab '${terminal.title}' running: ${params.command}` }],
        details: { title: terminal.title, command: params.command },
      };
    },
  }));
}

export function registerTerminalEvents(events: AtelierEventBus): void {
  registerTerminalAgentTool();
  events.on("workspace_created", async ({ workspaceId }) => {
    await createWorkspaceTerminal(workspaceId);
  });
}
