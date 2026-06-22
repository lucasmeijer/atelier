import type { WorkspaceCommandContribution, WorkspaceModule } from "@atelier/shared";
import { desktopAppKey, desktopTabKey, ensureWorkspaceDesktop, isWorkspaceDesktopEnabled } from "./runtime.ts";
import { renderDesktopTab } from "./render.ts";
import { resolveDesktopWorkspaceAppTarget } from "./proxy.ts";

export function desktopWorkspaceCommand(enabled: boolean): WorkspaceCommandContribution {
  return {
    id: "desktop.start",
    label: enabled ? "Open Desktop" : "Turn on Desktop",
    surfaces: { ui: { placement: "group-menu" } },
  };
}

export const desktopWorkspaceModule: WorkspaceModule = {
  id: "desktop",
  initialize(context) {
    context.registerWorkspaceAppHandler({
      matches: (app) => app.appKey === desktopAppKey,
      resolveTarget: (app, requestUrl) => resolveDesktopWorkspaceAppTarget(app, requestUrl),
    });
  },
  commands: [{
    id: "desktop.start",
    async execute({ workspaceId }) {
      await ensureWorkspaceDesktop(workspaceId);
      return { createdTabKey: desktopTabKey };
    },
  }],
  tabs: [{
    owns: (tabKey) => tabKey === desktopTabKey,
  }],
  async attachToWorkspace({ workspaceId }) {
    const enabled = await isWorkspaceDesktopEnabled(workspaceId);
    return {
      tabs: enabled ? [renderDesktopTab(workspaceId)] : [],
      workspaceCommands: [desktopWorkspaceCommand(enabled)],
    };
  },
};
