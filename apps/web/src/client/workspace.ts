/// <reference lib="dom" />

import { Application as StimulusApplication, Controller as StimulusController } from "@hotwired/stimulus";
// Turbo does not publish TypeScript declarations, but Bun resolves and bundles its browser module.
// @ts-expect-error No declaration file is included in @hotwired/turbo.
import * as Turbo from "@hotwired/turbo";
import { createProvisionTerminalController } from "@atelier/workspace/client";
import {
  installSoftwareKeyboardTracking,
  type AtelierCableClient,
  type WorkspaceClientControllerConstructor,
} from "@atelier/shared";
import { workspaceClientModules } from "./workspace-client-modules.generated.ts";
import { registerDesignSystemControllers } from "@atelier/design-system/client";
import { PwaReminderController } from "./pwa-reminder.ts";
import { AtelierEasterEggController } from "./atelier-easter-egg.ts";
import { clientHooks } from "./workspace-client-hooks.ts";
import { installWorkspaceCable } from "./workspace-cable.ts";
import { registerWorkspaceDevReloadController } from "./workspace-dev-reload.ts";
import { registerWorkspaceDialogControllers } from "./workspace-dialogs.ts";
import { registerWorkspaceFullscreenController } from "./workspace-fullscreen.ts";
import { registerWorkspaceNavigationControllers } from "./workspace-navigation.ts";
import { registerWorkspaceResidencyController } from "./workspace-residency.ts";
import { initializeWorkspaceControllerRegistry, registerWorkspaceControllers, workspaceNavigationController } from "./workspace-controller-registry.ts";
import { registerWorkspaceAppFrameController } from "./workspace-app-frame.ts";
import { registerWorkspaceSettingsControllers } from "./workspace-settings.ts";
import { registerWorkspaceShortcutsController } from "./workspace-shortcuts.ts";
import { createWorkspacePresentationController, installWorkspacePresentationTurboStream } from "./workspace-presentation.ts";

declare global {
  interface Window {
    Turbo?: { renderStreamMessage(html: string): void };
    AtelierCable?: AtelierCableClient;
  }
}

window.Turbo = Turbo;

const Controller: WorkspaceClientControllerConstructor = StimulusController;
const application = StimulusApplication.start();
installSoftwareKeyboardTracking();
initializeWorkspaceControllerRegistry(application);

installWorkspaceCable();
installWorkspacePresentationTurboStream(Turbo, application);
Turbo.StreamActions["select-workspace"] = function selectWorkspace(this: HTMLElement): void {
  const workspaceId = this.dataset.workspaceId;
  if (!workspaceId) throw new Error("select-workspace requires a Workspace id");
  void workspaceNavigationController()?.selectWorkspaceById(workspaceId);
};

for (const module of workspaceClientModules) await module.install({ application, Controller, hooks: clientHooks });
registerWorkspaceControllers({
  "pwa-reminder": PwaReminderController,
  "atelier-easter-egg": AtelierEasterEggController,
  "workspace-presentation": createWorkspacePresentationController(Controller, application, clientHooks),
});
registerWorkspaceNavigationControllers();
registerWorkspaceResidencyController();
registerWorkspaceShortcutsController();
registerWorkspaceFullscreenController();
registerWorkspaceDialogControllers();
registerWorkspaceAppFrameController();
registerWorkspaceSettingsControllers();
registerWorkspaceDevReloadController();
registerDesignSystemControllers(application);
registerWorkspaceControllers({
  "provision-terminal": createProvisionTerminalController(Controller),
});

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/service-worker.js");
}
