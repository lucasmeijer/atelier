import { AtelierCoreError, type AtelierEventBus } from "@atelier/core";
import type { WorkspaceLayoutPlacementController } from "@atelier/shared";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { terminalTabKey } from "../shared.ts";
import { listWorkspaceTerminals } from "./workspace-terminals.ts";

export interface PresentTmuxSessionToolDeps {
  getTabKeys(): Promise<string[]>;
  layouts: WorkspaceLayoutPlacementController;
  events?: AtelierEventBus;
}

export function createPresentTmuxSessionTool(workspaceId: string, deps: PresentTmuxSessionToolDeps): ToolDefinition<any, any> {
  return defineTool({
    name: "present_tmux_session",
    label: "Present Tmux Session",
    description: "Present a pre-existing tmux session to the user in Atelier. Use this to present your work when your work can best be evaluated or experimented with in a terminal session. Only one tmux session can be presented at the same time.",
    parameters: Type.Object({
      session: Type.String({
        description: "Exact name of the pre-existing tmux session to present. Do not include the terminal: tab prefix. The tmux session must already exist.",
      }),
    }),
    execute: async (_toolCallId: string, params: { session: string }) => {
      const { terminals } = await listWorkspaceTerminals(workspaceId);
      if (!terminals.some((terminal) => terminal.title === params.session)) {
        throw new AtelierCoreError("terminal_not_found", `tmux session not found: ${params.session}`);
      }

      const tabKey = terminalTabKey(params.session);
      const placement = deps.layouts.ensureTabInPreviewGroup(workspaceId, await deps.getTabKeys(), tabKey);
      await deps.events?.emit("workspace_tabs_changed", { workspaceId });

      return {
        content: [{ type: "text" as const, text: `Presented tmux session ${params.session}` }],
        details: {
          session: params.session,
          tab: tabKey,
          groupId: placement?.groupId,
          moved: placement?.moved ?? false,
          createdGroup: placement?.createdGroup ?? false,
        },
      };
    },
  });
}
