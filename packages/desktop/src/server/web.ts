import type { WorkspaceCommandContribution, WorkspaceModule } from "@atelier/shared";
import { isWorkspaceDesktopEnabled } from "./runtime.ts";
import { renderDesktopTab } from "./render.ts";

export function desktopWorkspaceCommand(enabled: boolean): WorkspaceCommandContribution {
  return {
    id: "desktop.start",
    label: enabled ? "Open Desktop" : "Turn on Desktop",
    surfaces: { ui: { placement: "group-menu" } },
  };
}

export const desktopWorkspaceModule: WorkspaceModule = {
  id: "desktop",
  async attachToWorkspace({ workspaceId }) {
    const enabled = await isWorkspaceDesktopEnabled(workspaceId);
    return {
      tabs: enabled ? [renderDesktopTab(workspaceId)] : [],
      workspaceCommands: [desktopWorkspaceCommand(enabled)],
    };
  },
};
