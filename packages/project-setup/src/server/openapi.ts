import type { JsonObject } from "@atelier/core";
const secretDecisionSchema = {
  type: "object", additionalProperties: false,
  required: ["envName", "hostPattern", "annotation", "optional", "decision"],
  properties: {
    envName: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
    hostPattern: { type: "string", minLength: 1 },
    annotation: { type: "string", description: "A succinct explanation of what the app uses this secret for." },
    placeholder: { type: "string" }, optional: { type: "boolean" },
    decision: { type: "string", enum: ["save", "skip"] },
    secretValue: { type: "string", writeOnly: true, description: "Required and non-empty for save. Ignored for skip." },
  },
};

const workspaceId = { name: "id", in: "path", required: true, schema: { type: "string" } };
const jsonResponse = (description: string) => ({ description, content: { "application/json": { schema: { type: "object" } } } });
export const projectSetupOpenApiPaths = {
  "/workspaces/{id}/project-setup/secret-request": {
    get: {
      summary: "Inspect the pending project secret request or open its workspace",
      description: "JSON returns request: null or an object with id, suggestion, and configured. Never includes a secret value. Browser navigation opens the workspace with its pending dialog. Requests wait in memory while the tool runs; an aborted tool or restarted server requires the agent to issue a new request.",
      parameters: [workspaceId],
      responses: { "200": jsonResponse("Pending request metadata"), "303": { description: "Open the workspace" } },
    },
  },
  "/workspaces/{id}/project-setup/secret-request/{requestId}": {
    post: {
      summary: "Save or defer an individual secret and resume the waiting tool",
      description: "Both decisions save the final definition. save requires a non-empty secretValue; skip ignores secretValue and preserves any previously stored value. The result includes the final secret summary, valueProvided, and changedFields, never the value itself.",
      parameters: [workspaceId, { name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      requestBody: { required: true, content: { "application/json": { schema: secretDecisionSchema } } },
      responses: { "200": jsonResponse("Saved secret metadata and user decision"), "400": jsonResponse("Invalid or expired request") },
    },
  },
  "/workspaces/{id}/project-setup/environment-request": {
    get: {
      summary: "Inspect the pending environment variable approval or open its workspace",
      description: "JSON returns request: null or { id, suggestion }. The agent uses add_project_settings_environment_variable to ask for permission, one variable at a time.",
      parameters: [workspaceId],
      responses: { "200": jsonResponse("Pending environment variable request"), "303": { description: "Open the workspace" } },
    },
  },
  "/workspaces/{id}/project-setup/environment-request/{requestId}": {
    post: {
      summary: "Approve or decline an environment variable and resume the waiting tool",
      description: "save persists the final name and value (including an empty value). skip leaves project settings unchanged. Returns saved, settings, and changedFields.",
      parameters: [workspaceId, { name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", required: ["name", "value", "decision"], additionalProperties: false,
        properties: { name: { type: "string" }, value: { type: "string" }, decision: { type: "string", enum: ["save", "skip"] } },
      } } } },
      responses: { "200": jsonResponse("User decision and final environment variable settings"), "400": jsonResponse("Invalid or expired request") },
    },
  },
} satisfies Record<string, JsonObject>;
