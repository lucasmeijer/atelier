import { AtelierCoreError } from "@atelier/core";
import type { WorkspacePresenterDefinition, WorkspacePresenterDeps } from "@atelier/agent/server";
import { Type } from "typebox";
import { terminalTabKey } from "../shared.ts";
import { attachWorkspaceTerminal, listWorkspaceTerminals, tmuxSessionExists } from "./workspace-terminals.ts";

export function createTmuxPresenter(workspaceId: string, deps: WorkspacePresenterDeps): WorkspacePresenterDefinition<{ kind: "tmux"; session: string }> {
  return {
    kind: "tmux",
    description: "Present an existing tmux session in Atelier's preview area. If needed, this opens a persisted terminal tab attached to that session.",
    parameters: {
      session: Type.String({ description: "Exact name of the pre-existing tmux session. The session must already exist." }),
    },
    execute: async (_toolCallId, params) => {
      const existing = (await listWorkspaceTerminals(workspaceId)).find((terminal) => terminal.tmuxSession === params.session);
      let terminal = existing;
      if (terminal) {
        if (!(await tmuxSessionExists(workspaceId, params.session))) {
          throw new AtelierCoreError("terminal_not_found", `tmux session not found: ${params.session}`);
        }
      } else {
        terminal = await attachWorkspaceTerminal(workspaceId, params.session);
      }

      const tabKey = terminalTabKey(terminal.id);
      await deps.events?.emit("workspace_tabs_changed", { workspaceId });
      await deps.presentWorkView({ type: "terminal", terminalId: terminal.id });
      return {
        content: [{ type: "text" as const, text: `Presented tmux session ${params.session}` }],
        details: {
          session: params.session,
          workView: { type: "terminal", terminalId: terminal.id },
          sourceKey: tabKey,
        },
      };
    },
  };
}
