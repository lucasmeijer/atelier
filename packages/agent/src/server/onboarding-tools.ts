import { isProjectOnboardingWorkspace } from "./workspace-capabilities.ts";
import type { DeleteCurrentWorkspaceResult } from "@atelier/shared";
import { AtelierCoreError } from "@atelier/core";
import { isGitProjectInit, projectWorkspaceInitWithSettings, projectWorkspaceSettingsSchema, readProjectWorkspaceSettings, writeProjectWorkspaceSettings, type GitProjectInitInstruction, type ProjectWorkspaceSettings } from "@atelier/projects";
import { getWorkspaceInit, type WorkspaceInitInstruction, type WorkspaceProvisionStep } from "@atelier/workspace";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createTmuxBashTool } from "./bash-tmux.ts";

type ToolUpdate = NonNullable<Parameters<ToolDefinition<any, any>["execute"]>[3]>;
export interface SecretValueRequest {
  envName: string;
  purpose: string;
  hostPattern: string;
  placeholder?: string;
}
export interface CreatedOnboardingWorkspace {
  workspaceId: string;
  url: string;
  status: "ready" | "failed" | "deleted" | "awaiting_user";
  error?: string;
  settings?: ProjectWorkspaceSettings;
  timings: { totalMs?: number; phases: Array<Pick<WorkspaceProvisionStep, "id" | "label" | "durationMs" | "status" | "error">> };
}
export type RequestedSecretValue = { status: "cancelled"; envName: string } | {
  status: "saved";
  settingsRevision: string;
  envName: string;
  placeholder: string;
  hostPattern: string;
  egressReplacement: "active_for_new_connections";
  reconnectRequired: true;
  existingProcessEnvironmentUpdated: false;
};
export interface OnboardingToolDependencies {
  deleteWorkspace(workspaceId: string, force: boolean): Promise<DeleteCurrentWorkspaceResult>;
  createWorkspace(init: GitProjectInitInstruction, title: string, signal: AbortSignal | undefined, onUpdate: ToolUpdate | undefined): Promise<CreatedOnboardingWorkspace>;
  requestSecretValue(projectId: string, request: SecretValueRequest, signal: AbortSignal | undefined, onUpdate: ToolUpdate | undefined): Promise<RequestedSecretValue>;
  getWorkspaceInit?: (workspaceId: string) => Promise<WorkspaceInitInstruction | undefined>;
  createBashTool?: typeof createTmuxBashTool;
}

function result<T>(value: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

/** Registered capabilities, intentionally separate from skill discovery and activation. */
export function createOnboardingTools(workspaceId: string, conversationId: string, deps: OnboardingToolDependencies): ToolDefinition<any, any>[] {
  const loadInit = deps.getWorkspaceInit ?? getWorkspaceInit;
  async function project() {
    const init = await loadInit(workspaceId);
    if (!isGitProjectInit(init)) throw new AtelierCoreError("project_required", "This workspace does not belong to a project");
    return init;
  }
  async function requireOwnedWorkspace(targetId: string, action: string) {
    const source = await project();
    const target = await loadInit(targetId);
    if (targetId === workspaceId || !isGitProjectInit(target) || target.projectId !== source.projectId || target.createdBy?.workspaceId !== workspaceId || target.createdBy.conversationId !== conversationId) {
      throw new AtelierCoreError("workspace_access_denied", `You may only ${action} another workspace created by this agent conversation for its own project`);
    }
  }
  const bashFactory = deps.createBashTool ?? createTmuxBashTool;
  const bash = bashFactory(workspaceId);
  return [
    defineTool({
      name: "read_project_settings", label: "Read project settings",
      description: "Read your workspace's project configuration and revision, including secret metadata and placeholders but never secret values. Repository identity is read-only. An empty Dockerfile uses the repository .atelier/Dockerfile if present, otherwise the default image. To bypass repository customization, supply a Dockerfile containing only FROM atelier-workspace.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => result(await readProjectWorkspaceSettings((await project()).projectId)),
    }),
    defineTool({
      name: "write_project_settings", label: "Write project settings",
      description: "Replace your project's complete workspace settings. Present the differences to the user before calling. Changes apply to future workspaces only. Supply the latest settings revision; reread on conflict. Repository identity and secrets cannot be changed here. Use request_secret_value for credentials.",
      parameters: Type.Object({ expectedRevision: Type.String(), settings: projectWorkspaceSettingsSchema }, { additionalProperties: false }),
      execute: async (_id, args) => result(await writeProjectWorkspaceSettings((await project()).projectId, args.expectedRevision, args.settings)),
    }),
    defineTool({
      name: "request_secret_value", label: "Request project secret",
      description: "Ask the user to enter a secret in a focused secure dialog, never in chat. The value is saved to the project immediately and egress replacement is updated for new connections from running workspaces. Reconnect existing HTTP/HTTPS clients (or restart the relevant application) before using the placeholder: existing opaque CONNECT tunnels are not reconfigured. A workspace restart is not required. Waits for user input; stopping the call cancels the wait, not a saved secret. Use the returned placeholder as the environment variable's value for commands; existing processes do not receive new environment variables. Reread project settings afterward before writing settings. Host restrictions limit where the credential can be used. Requests that conflict with an existing secret’s hosts or placeholder are rejected; read the stored metadata first.",
      parameters: Type.Object({ envName: Type.String(), purpose: Type.String(), hostPattern: Type.String(), placeholder: Type.Optional(Type.String()) }, { additionalProperties: false }),
      execute: async (_id, args, signal, update) => result(await deps.requestSecretValue((await project()).projectId, args, signal, update)),
    }),
    defineTool({
      name: "bash_in_other_workspace", label: "Bash in other workspace",
      description: "Execute bash in another workspace created by this agent conversation. Supply the destination workspace_id every time. For your current workspace, use normal bash. Output file paths belong to the destination workspace.\n\n" + bash.description,
      parameters: Type.Object({ ...bash.parameters.properties, workspace_id: Type.String({ description: "ID of another workspace created by this agent conversation" }) }, { additionalProperties: false }),
      execute: async (id, args: { workspace_id: string; command: string; timeout?: number }, signal, update, context) => {
        await requireOwnedWorkspace(args.workspace_id, "execute bash in");
        const remote = bashFactory(args.workspace_id);
        return remote.execute(id, { command: args.command, timeout: args.timeout }, signal, update, context);
      },
    }),
    defineTool({
      name: "delete_workspace", label: "Delete workspace",
      description: "Delete another workspace created by this agent conversation for its own project. Cannot delete your current workspace. Supply workspace_id every time. Set force to false to run deletion safety checks; use force only when the user explicitly approves discarding unsaved changes. Deletion is permanent and runs asynchronously.",
      parameters: Type.Object({ workspace_id: Type.String({ description: "ID of another workspace created by this agent conversation" }), force: Type.Boolean() }, { additionalProperties: false }),
      execute: async (_id, args) => {
        await requireOwnedWorkspace(args.workspace_id, "delete");
        return result(await deps.deleteWorkspace(args.workspace_id, args.force));
      },
    }),
    defineTool({
      name: "create_workspace", label: "Create workspace",
      description: "Create an ordinary visible workspace for your own project using complete settings without changing saved project settings. Repository and branch cannot be overridden. Project secrets are used. Streams provisioning progress and returns the workspace ID, URL, status and creation timings. The workspace survives tool cancellation. Use bash_in_other_workspace to investigate it afterward.",
      parameters: Type.Object({ title: Type.String(), expectedRevision: Type.String(), settings: projectWorkspaceSettingsSchema }, { additionalProperties: false }),
      execute: async (_id, args, signal, update) => {
        const init = await projectWorkspaceInitWithSettings((await project()).projectId, args.expectedRevision, args.settings, { workspaceId, conversationId });
        return result(await deps.createWorkspace(init, args.title, signal, update));
      },
    }),
  ];
}

let onboardingDependencies: OnboardingToolDependencies | undefined;

/** Host composition only; this installs the group, not permission to use it. */
export function configureOnboardingTools(deps: OnboardingToolDependencies | undefined): void {
  onboardingDependencies = deps;
}

export function createRegisteredOnboardingTools(workspaceId: string, conversationId: string): ToolDefinition<any, any>[] {
  return onboardingDependencies && isProjectOnboardingWorkspace(workspaceId) ? createOnboardingTools(workspaceId, conversationId, onboardingDependencies) : [];
}
