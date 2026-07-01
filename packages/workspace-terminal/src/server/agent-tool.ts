import { AtelierCoreError } from "@atelier/core";
import type { WorkspacePresenterDefinition, WorkspacePresenterDeps } from "@atelier/agent/server";
import { Type } from "typebox";
import { terminalTabKey } from "../shared.ts";
import { listWorkspaceTerminals } from "./workspace-terminals.ts";

export function createTmuxPresenter(workspaceId: string, deps: WorkspacePresenterDeps): WorkspacePresenterDefinition<{ kind: "tmux"; session: string }> {
  return {
    kind: "tmux",
    description: "Present an existing tmux session in Atelier's preview area.",
    parameters: {
      session: Type.String({
        description: "Exact name of the pre-existing tmux session to present. Do not include any Atelier terminal tab prefix. The tmux session must already exist.",
      }),
    },
    execute: async (_toolCallId: string, params: { kind: "tmux"; session: string }) => {
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
  };
}
