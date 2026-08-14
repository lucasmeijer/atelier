import type { WorkspaceCommandContribution, WorkspaceModule } from "@atelier/shared";
import { desktopAppKey, desktopTabKey, ensureWorkspaceDesktop, isWorkspaceDesktopEnabled } from "./runtime.ts";
import { renderDesktopTab } from "./render.ts";
import { resolveDesktopWorkspaceAppTarget } from "./proxy.ts";

type WorkspacePlanEvents = { on(eventName: "workspace_plan_prepare", handler: (event: { plan: { initScripts: string[] } }) => void): void };
const enabledWorkspaces = new Map<string, boolean>();

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
  workViews: [{
    type: "desktop",
    parseReference(value: unknown) {
      const reference = value as { type?: unknown };
      if (reference?.type !== "desktop" || Object.keys(reference).length !== 1) throw new Error("desktop reference has no identity fields");
      return { type: "desktop" };
    },
    identity: () => "workspace",
  }],
  initialize(context) {
    (context.events as WorkspacePlanEvents).on("workspace_plan_prepare", ({ plan }) => {
      plan.initScripts.push(`if command -v dbus-daemon >/dev/null 2>&1 && [ -f /usr/share/dbus-1/system.conf ]; then mkdir -p /run/dbus; dbus-daemon --system --fork 2>/dev/null || true; fi`);
    });
    context.registerWorkspaceAppHandler({
      matches: (app) => app.appKey === desktopAppKey,
      resolveTarget: (app, requestUrl) => resolveDesktopWorkspaceAppTarget(app, requestUrl),
    });
    context.onWorkspaceRemoved((workspaceId) => { enabledWorkspaces.delete(workspaceId); });
  },
  commands: [{
    id: "desktop.start",
    async execute({ workspaceId }) {
      await ensureWorkspaceDesktop(workspaceId);
      enabledWorkspaces.set(workspaceId, true);
      return { createdTabKey: desktopTabKey };
    },
  }],
  tabs: [{
    owns: (tabKey) => tabKey === desktopTabKey,
  }],
  async attachToWorkspace({ workspaceId }) {
    let enabled = enabledWorkspaces.get(workspaceId);
    if (enabled === undefined) {
      enabled = await isWorkspaceDesktopEnabled(workspaceId);
      enabledWorkspaces.set(workspaceId, enabled);
    }
    return {
      tabs: enabled ? [renderDesktopTab(workspaceId)] : [],
      commands: [desktopWorkspaceCommand(enabled)],
    };
  },
};
