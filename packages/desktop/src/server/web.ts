import type { JsonValue } from "@atelier/core";
import type { WorkspaceCommandContribution, WorkspaceModule } from "@atelier/shared";
import { desktopAppKey, ensureWorkspaceDesktop, isWorkspaceDesktopEnabled } from "./runtime.ts";
import { desktopWorkViewPresentation, renderDesktopWorkViewBody } from "./render.ts";
import { resolveDesktopWorkspaceAppTarget } from "./proxy.ts";

const enabledWorkspaces = new Map<string, boolean>();

export function desktopWorkspaceCommand(enabled: boolean): WorkspaceCommandContribution {
  return {
    id: "desktop.start",
    label: enabled ? "Open Desktop" : "Turn on Desktop",
    scope: "workspace",
    surfaces: { ui: { placement: "work-launcher", label: "Desktop" } },
  };
}

export const desktopWorkspaceModule: WorkspaceModule = {
  id: "desktop",
  workViews: [{
    type: "desktop",
    parseReference(value: JsonValue) {
      // SAFETY: The module boundary validates or constructs this value with the asserted domain shape.
      const reference = value as { type?: unknown };
      if (reference?.type !== "desktop" || Object.keys(reference).length !== 1) throw new Error("desktop reference has no identity fields");
      return { type: "desktop" };
    },
    identity: () => "workspace",
    render: ({ workspaceId }) => renderDesktopWorkViewBody(workspaceId),
  }],
  initialize(context) {
    context.events.on("workspace_plan_prepare", ({ plan }) => {
      plan.initScripts.push(`if command -v dbus-daemon >/dev/null 2>&1 && [ -f /usr/share/dbus-1/system.conf ]; then mkdir -p /run/dbus; dbus-daemon --system --fork 2>/dev/null || true; fi`);
    });
    context.registerWorkspaceAppResolver(async (app, requestUrl) => app.appKey === desktopAppKey
      ? { kind: "http", target: await resolveDesktopWorkspaceAppTarget(app, requestUrl) }
      : undefined);
    context.onWorkspaceRemoved((workspaceId) => { enabledWorkspaces.delete(workspaceId); });
  },
  commands: [{
    id: "desktop.start",
    async execute({ workspaceId }) {
      await ensureWorkspaceDesktop(workspaceId);
      enabledWorkspaces.set(workspaceId, true);
      return { createdWorkView: { type: "desktop" } };
    },
  }],
  async attachToWorkspace({ workspaceId }) {
    let enabled = enabledWorkspaces.get(workspaceId);
    if (enabled === undefined) {
      enabled = await isWorkspaceDesktopEnabled(workspaceId);
      enabledWorkspaces.set(workspaceId, enabled);
    }
    return {
      workViews: enabled ? [desktopWorkViewPresentation] : [],
      commands: [desktopWorkspaceCommand(enabled)],
    };
  },
};
