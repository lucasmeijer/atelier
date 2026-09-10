import { copyFile, mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { registerConversationAgentTool } from "@atelier/agent";
import { atelierDataPath, dockerHostAtelierDataPath, getAtelierRuntimeContext } from "@atelier/core";
import { turboStream, type WorkspaceModule, type WorkspaceServerModuleContext } from "@atelier/shared";
import { projectSetupGuidePath } from "../prompt.ts";
import { addProjectSecretToolName, createAddProjectSecretTool, addProjectEnvironmentVariableToolName, createAddProjectEnvironmentVariableTool, setProjectDockerfileToolName, createSetProjectDockerfileTool } from "../tool.ts";

import { createEnvironmentRequests } from "../environment-requests.ts";
import { environmentRequestDialog, environmentRequestHostId, environmentRequestOverlay, environmentRequestRoutes } from "./environment-dialog.ts";
import { createSecretRequests } from "../secret-requests.ts";
import { secretRequestDialog, secretRequestHostId, secretRequestOverlay, secretRequestRoutes } from "./secret-dialog.ts";

import { projectSetupOpenApiPaths } from "./openapi.ts";

let broadcastWorkspace: WorkspaceServerModuleContext["broadcastWorkspace"];
const requests = createSecretRequests((workspaceId) => {
  const pending = requests.forWorkspace(workspaceId);
  broadcastWorkspace(workspaceId, turboStream("update", secretRequestHostId(workspaceId), pending ? secretRequestDialog(pending) : ""));
});

const environmentRequests = createEnvironmentRequests((workspaceId) => {
  const pending = environmentRequests.forWorkspace(workspaceId);
  broadcastWorkspace(workspaceId, turboStream("update", environmentRequestHostId(workspaceId), pending ? environmentRequestDialog(pending) : ""));
});

export const atelierServerModule = {
  id: "project-setup",
  staticFiles: { "/project-setup.css": { url: new URL("../project-setup.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  routes: [secretRequestRoutes(requests), environmentRequestRoutes(environmentRequests)],
  openApiPaths: projectSetupOpenApiPaths,
  attachToWorkspace({ workspaceId }) { return { overlayHtml: [secretRequestOverlay(workspaceId, requests), environmentRequestOverlay(workspaceId, environmentRequests)] }; },
  async initialize(context: Pick<WorkspaceServerModuleContext, "events" | "broadcastWorkspace" | "onWorkspaceRemoved">) {
    const { events } = context;
    broadcastWorkspace = context.broadcastWorkspace;
    context.onWorkspaceRemoved((workspaceId) => {
      requests.cancelWorkspace(workspaceId);
      environmentRequests.cancelWorkspace(workspaceId);
    });
    const runtime = getAtelierRuntimeContext();
    await mkdir(atelierDataPath(runtime, "project-setup"), { recursive: true });
    await copyFile(new URL("../../docs/configure-user-project.md", import.meta.url), atelierDataPath(runtime, "project-setup", basename(projectSetupGuidePath)));
    events.on("workspace_plan_prepare", ({ plan }) => {
      plan.mounts.push({
        type: "bind",
        source: dockerHostAtelierDataPath(runtime, "project-setup"),
        target: dirname(projectSetupGuidePath),
        readonly: true,
      });
    });
    registerConversationAgentTool(addProjectSecretToolName, (binding, workspaceId) => createAddProjectSecretTool(binding, workspaceId, requests));
    registerConversationAgentTool(addProjectEnvironmentVariableToolName, (binding, workspaceId) => createAddProjectEnvironmentVariableTool(binding, workspaceId, environmentRequests));
    registerConversationAgentTool(setProjectDockerfileToolName, createSetProjectDockerfileTool);
  },
} satisfies WorkspaceModule;
