import { recentWorkspaceProjectStorageKey, type WorkspaceClientHooks } from "@atelier/shared";

export function registerLaunchComposerCommand(hooks: WorkspaceClientHooks): void {
  hooks.registerCommand({
    id: "agent.open-launch-composer",
    label: "New Workspace With Same Project",
    description: "Open a LaunchComposer using the most recently selected Workspace's Project.",
    scope: "global",
    binding: "Meta+Alt+Quote",
    run() {
      const resident = document.querySelector<HTMLElement>(".workspace-detail-resident.visible");
      const projectId = resident ? resident.dataset.projectId : localStorage.getItem(recentWorkspaceProjectStorageKey);
      const frame = document.getElementById("launch_composer")!;
      frame.replaceChildren();
      frame.removeAttribute("src");
      frame.setAttribute("src", projectId ? `/projects/${encodeURIComponent(projectId)}/launch-composer` : "/launch-composer");
    },
  });
}
