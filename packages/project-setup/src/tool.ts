import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { JsonObject } from "@atelier/core";
import { setProjectDockerfile } from "@atelier/projects";
import { secretSuggestionSchema, type SecretRequests } from "./secret-requests.ts";
import { environmentSuggestionSchema, type EnvironmentRequests } from "./environment-requests.ts";

export const addProjectSecretToolName = "add_project_secret";
export const addProjectEnvironmentVariableToolName = "add_project_settings_environment_variable";
export const setProjectDockerfileToolName = "set_project_settings_dockerfile";
const bindingSchema = Type.Object({ projectId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const dockerfileSchema = Type.Object({
  dockerfile: Type.String({ description: "The complete custom Atelier Dockerfile approved by the user. Non-empty content must start with FROM atelier-workspace. An empty string clears the override; only clear it with the user's permission." }),
}, { additionalProperties: false });

export function createSetProjectDockerfileTool(context: JsonObject) {
  Value.Assert(bindingSchema, context);
  const projectId = context.projectId;
  return defineTool({
    name: setProjectDockerfileToolName,
    label: "Set project Dockerfile",
    description: "Set only this project's custom Atelier Dockerfile. First read the mounted Customizing Workspaces documentation, experiment with the minimum necessary system dependencies, and demonstrate an improvement in time from container start to project build finish. Do not bake package-manager project dependencies into the image. Show the full Dockerfile to the user and obtain permission before calling: this tool saves immediately, with no confirmation dialog. Leave the existing setting alone if a custom Dockerfile is not beneficial. Does not commit or push anything, change secrets or environment variables, or create, delete, or select workspaces. When setup is complete, explain that the user can create her first project workspace and safely delete this setup workspace herself.",
    parameters: dockerfileSchema,
    async execute(_toolCallId, input) {
      Value.Assert(dockerfileSchema, input);
      await setProjectDockerfile(projectId, input.dockerfile);
      return {
        content: [{ type: "text" as const, text: "Project Dockerfile saved for future workspaces. This setup workspace is unchanged." }],
        details: { projectId, settingsUrl: `/projects/${encodeURIComponent(projectId)}/settings?section=dockerfile` },
      };
    },
  });
}

export function createAddProjectSecretTool(context: JsonObject, workspaceId: string, requests: SecretRequests) {
  Value.Assert(bindingSchema, context);
  return defineTool({
    name: addProjectSecretToolName,
    label: "Add project secret",
    description: "Offer one project secret in an editable dialog and wait for the user's decision. Suggest its environment variable, host, succinct purpose, requirement, and optionally a placeholder. The user can edit these settings and either save a value or defer entering one. Both choices save the definition; deferring preserves any existing value. Returns the final settings, configured status, whether a value was provided, and changed fields, never the value. Offer secrets one at a time and do not ask for values in chat. These secrets do not become available in the current setup workspace: accomplish the investigation without them. Does not commit, push, or change workspace lifecycle.",
    parameters: secretSuggestionSchema,
    async execute(_toolCallId, input, signal) {
      const result = await requests.request(workspaceId, context.projectId, input, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });
}

export function createAddProjectEnvironmentVariableTool(context: JsonObject, workspaceId: string, requests: EnvironmentRequests) {
  Value.Assert(bindingSchema, context);
  return defineTool({
    name: addProjectEnvironmentVariableToolName,
    label: "Add project environment variable",
    description: "Ask permission for one non-secret project environment variable in an editable dialog and wait for the user. Saving adds the variable or updates an existing variable of the suggested name, with the user's final name and value. Skipping leaves project settings unchanged. Returns whether it was saved, the final proposed settings, and changed fields. Request variables one at a time. If none are needed, do not bring environment variables up with the user; this is not a common feature. Never submit secrets here. Saved variables apply to future project workspaces, not this setup workspace. Does not commit, push, create or delete workspaces.",
    parameters: environmentSuggestionSchema,
    async execute(_toolCallId, input, signal) {
      const result = await requests.request(workspaceId, context.projectId, input, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
    },
  });
}
