import type { WorkspaceCommandContribution, WorkspaceModule } from "@atelier/shared";
import { desktopAppKey, desktopTabKey, ensureWorkspaceDesktop, isWorkspaceDesktopEnabled } from "./runtime.ts";
import { renderDesktopTab } from "./render.ts";
import { resolveDesktopWorkspaceAppTarget } from "./proxy.ts";

type WorkspacePlanEvents = { on(eventName: "workspace_plan_prepare", handler: (event: { plan: { initScripts: string[] } }) => void): void };

export function desktopWorkspaceCommand(enabled: boolean): WorkspaceCommandContribution {
  return {
    id: "desktop.start",
    label: enabled ? "Open Desktop" : "Turn on Desktop",
    scope: "workspace",
    surfaces: { ui: { placement: "group-menu" } },
  };
}

export const desktopWorkspaceModule: WorkspaceModule = {
  id: "desktop",
  initialize(context) {
    (context.events as WorkspacePlanEvents).on("workspace_plan_prepare", ({ plan }) => {
      plan.initScripts.push(`if command -v dbus-daemon >/dev/null 2>&1 && [ -f /usr/share/dbus-1/system.conf ]; then mkdir -p /run/dbus; dbus-daemon --system --fork 2>/dev/null || true; fi`);
    });
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
      commands: [desktopWorkspaceCommand(enabled)],
    };
  },
};
