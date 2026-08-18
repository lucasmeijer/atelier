import { emptyWorkspaceCommandInputSchema, type WorkspaceModuleCommandHandler } from "@atelier/shared";
import type { TSchema } from "typebox";

const errorResponse = {
  description: "Request failed",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const jsonResponse = (description: string, schema: TSchema, status = "200") => ({
  [status]: { description, content: { "application/json": { schema } } },
  "400": errorResponse,
  "404": errorResponse,
});
const workspaceId = { name: "id", in: "path", required: true, schema: { type: "string" } };
const projectId = { name: "projectId", in: "path", required: true, schema: { type: "string" } };
const variableId = { name: "variableId", in: "path", required: true, schema: { type: "string" } };
const secretId = { name: "secretId", in: "path", required: true, schema: { type: "string" } };
const agentLabel = { name: "label", in: "path", required: true, schema: { type: "string" } };
const jsonBody = (schema: TSchema) => ({ required: true, content: { "application/json": { schema } } });
const emptyObjectSchema = { type: "object", additionalProperties: false };
const projectSummaryProperties = { id: { type: "string" }, name: { type: "string" }, gitUrl: { type: "string" }, branch: { type: ["string", "null"] }, sessionShareKey: { type: "string" } };

export function atelierOpenApi(commands: WorkspaceModuleCommandHandler[]) {
  const commandSchemas = Object.fromEntries(commands.map((command) => [command.id, command.inputSchema ?? emptyWorkspaceCommandInputSchema]));
  return {
    openapi: "3.1.0",
    info: {
      title: "Atelier automation interface",
      version: "1.0.0",
      description: "JSON representations of Atelier's content-negotiated UI operations. Send Accept: application/json.",
    },
    paths: {
      "/up": { get: { summary: "Health check", responses: { "200": { description: "Atelier is healthy", content: { "text/plain": { schema: { type: "string" } } } } } } },
      "/workspaces": {
        get: { summary: "List workspaces", responses: jsonResponse("Workspace summaries", { type: "object", required: ["workspaces"], properties: { workspaces: { type: "array", items: { $ref: "#/components/schemas/WorkspaceSummary" } } } }) },
        post: { summary: "Create a workspace asynchronously", requestBody: jsonBody({ $ref: "#/components/schemas/CreateWorkspace" }), responses: jsonResponse("Workspace creation accepted", { $ref: "#/components/schemas/WorkspaceEnvelope" }, "202") },
      },
      "/projects": {
        get: { summary: "List projects", responses: jsonResponse("Project summaries", { type: "object", required: ["projects"], properties: { projects: { type: "array", items: { $ref: "#/components/schemas/ProjectSummary" } } } }) },
        post: { summary: "Create or resolve a project", description: "Creates a project, or resolves and returns the existing project when the same repository specification was previously added.", requestBody: jsonBody({ type: "object", required: ["gitUrl"], properties: { gitUrl: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Project created or resolved", { $ref: "#/components/schemas/ProjectEnvelope" }) },
      },
      "/projects/{projectId}": {
        get: { summary: "Inspect project configuration", parameters: [projectId], responses: jsonResponse("Project configuration", { $ref: "#/components/schemas/ProjectConfigurationEnvelope" }) },
        post: { summary: "Update a project", parameters: [projectId], requestBody: jsonBody({ type: "object", required: ["name", "gitUrl"], properties: { name: { type: "string" }, gitUrl: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Project updated", { $ref: "#/components/schemas/ProjectEnvelope" }) },
      },
      "/projects/{projectId}/environment": { post: { summary: "Create a project environment variable", parameters: [projectId], requestBody: jsonBody({ $ref: "#/components/schemas/EnvironmentVariableInput" }), responses: jsonResponse("Environment variable created", { $ref: "#/components/schemas/EnvironmentVariableEnvelope" }) } },
      "/projects/{projectId}/environment/{variableId}": { post: { summary: "Update a project environment variable", parameters: [projectId, variableId], requestBody: jsonBody({ $ref: "#/components/schemas/EnvironmentVariableInput" }), responses: jsonResponse("Environment variable updated", { $ref: "#/components/schemas/EnvironmentVariableEnvelope" }) } },
      "/projects/{projectId}/environment/{variableId}/delete": { post: { summary: "Delete a project environment variable", parameters: [projectId, variableId], requestBody: jsonBody(emptyObjectSchema), responses: jsonResponse("Environment variable deleted", { type: "object", required: ["deleted", "environmentVariable"], properties: { deleted: { const: true }, environmentVariable: { $ref: "#/components/schemas/EnvironmentVariable" } } }) } },
      "/projects/{projectId}/secrets": { post: { summary: "Create a project secret", description: "The secretValue is encrypted and is never returned.", parameters: [projectId], requestBody: jsonBody({ $ref: "#/components/schemas/CreateSecret" }), responses: jsonResponse("Secret metadata created", { $ref: "#/components/schemas/SecretEnvelope" }) } },
      "/projects/{projectId}/secrets/{secretId}": { post: { summary: "Update a project secret", description: "Omit secretValue to preserve the stored secret. The value is never returned.", parameters: [projectId, secretId], requestBody: jsonBody({ $ref: "#/components/schemas/UpdateSecret" }), responses: jsonResponse("Secret metadata updated", { $ref: "#/components/schemas/SecretEnvelope" }) } },
      "/projects/{projectId}/secrets/{secretId}/delete": { post: { summary: "Delete a project secret", parameters: [projectId, secretId], requestBody: jsonBody(emptyObjectSchema), responses: jsonResponse("Secret deleted", { type: "object", required: ["deleted", "secret"], properties: { deleted: { const: true }, secret: { $ref: "#/components/schemas/SecretSummary" } } }) } },
      "/projects/{projectId}/delete": { post: { summary: "Delete a project", parameters: [projectId], requestBody: jsonBody(emptyObjectSchema), responses: jsonResponse("Project deleted or blocked by workspace references", { $ref: "#/components/schemas/DeleteProjectResult" }) } },
      "/workspaces/{id}": { get: { summary: "Inspect workspace readiness, Agent conversations, Work views, and commands", parameters: [workspaceId], responses: jsonResponse("Workspace state", { $ref: "#/components/schemas/WorkspaceEnvelope" }) } },
      "/workspaces/{id}/sidebar-title": { post: { summary: "Rename a workspace", parameters: [workspaceId], requestBody: jsonBody({ type: "object", required: ["title"], properties: { title: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Workspace renamed", { $ref: "#/components/schemas/WorkspaceEnvelope" }) } },
      "/workspaces/{id}/commands/{commandId}": { post: { summary: "Execute a workspace command", parameters: [workspaceId, { name: "commandId", in: "path", required: true, schema: { type: "string", enum: Object.keys(commandSchemas) } }], requestBody: jsonBody({ anyOf: Object.values(commandSchemas) }), responses: jsonResponse("Command executed", { $ref: "#/components/schemas/CommandResult" }), "x-atelier-command-schemas": commandSchemas } },
      "/workspaces/{id}/browser/{browserId}/navigate": { post: { summary: "Navigate a Browser Work view", parameters: [workspaceId, { name: "browserId", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ type: "object", required: ["url"], properties: { url: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Browser navigated", { type: "object" }) } },
      "/workspaces/{id}/work-views/reorder": { post: { summary: "Reorder a typed Work view", parameters: [workspaceId], requestBody: jsonBody({ type: "object", required: ["key", "index"], properties: { key: { type: "string" }, index: { type: "integer", minimum: 0 } }, additionalProperties: false }), responses: jsonResponse("Work views reordered", { $ref: "#/components/schemas/WorkViewsEnvelope" }) } },
      "/workspaces/{id}/work-views/{key}/attention/request": { post: { summary: "Present a Work view and request Attention", parameters: [workspaceId, { name: "key", in: "path", required: true, schema: { type: "string" } }], responses: jsonResponse("Attention requested", { type: "object" }) } },
      "/workspaces/{id}/work-views/{key}/attention/acknowledge": { post: { summary: "Acknowledge Work-view Attention", parameters: [workspaceId, { name: "key", in: "path", required: true, schema: { type: "string" } }], responses: jsonResponse("Attention acknowledged", { type: "object" }) } },
      "/workspaces/{id}/work-views/close": { post: { summary: "Close a typed Work view", parameters: [workspaceId], requestBody: jsonBody({ type: "object", required: ["reference"], properties: { reference: { $ref: "#/components/schemas/WorkViewReference" } }, additionalProperties: false }), responses: jsonResponse("Work view closed", { $ref: "#/components/schemas/WorkViewsEnvelope" }) } },
      "/workspaces/{id}/agent-conversations/{conversationId}/close": { post: { summary: "Archive an Agent conversation", parameters: [workspaceId, { name: "conversationId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: jsonResponse("Agent conversation archived", { type: "object" }) } },
      "/workspaces/{id}/park": { post: { summary: "Park a workspace", parameters: [workspaceId], responses: jsonResponse("Workspace parked", { type: "object" }) } },
      "/workspaces/{id}/unpark": { post: { summary: "Unpark a workspace", parameters: [workspaceId], responses: jsonResponse("Workspace unparked", { type: "object" }) } },
      "/workspaces/{id}/delete": { post: { summary: "Delete a workspace", parameters: [workspaceId], requestBody: jsonBody({ type: "object", properties: { force: { type: "boolean" } }, additionalProperties: false }), responses: jsonResponse("Workspace deletion scheduled or blocked", { type: "object" }) } },
      "/workspaces/{id}/agents/{label}/messages": { post: { summary: "Submit or steer an agent message", parameters: [workspaceId, agentLabel], requestBody: jsonBody({ type: "object", required: ["text"], properties: { text: { type: "string" }, mode: { type: "string", enum: ["send", "steer"] } }, additionalProperties: false }), responses: jsonResponse("Message accepted", { type: "object" }, "202") } },
      "/workspaces/{id}/agents/{label}/model": { post: { summary: "Select an agent model", parameters: [workspaceId, agentLabel], requestBody: jsonBody({ type: "object", required: ["model"], properties: { model: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Model selected", { type: "object" }) } },
      "/workspaces/{id}/agents/{label}/thinking": { post: { summary: "Select an agent thinking level", parameters: [workspaceId, agentLabel], requestBody: jsonBody({ type: "object", required: ["level"], properties: { level: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Thinking level selected", { type: "object" }) } },
      "/workspaces/{id}/agents/{label}/service-tier": { post: { summary: "Select an agent inference service tier", parameters: [workspaceId, agentLabel], requestBody: jsonBody({ type: "object", required: ["serviceTier"], properties: { serviceTier: { type: "string", enum: ["default", "priority"] } }, additionalProperties: false }), responses: jsonResponse("Service tier selected", { type: "object" }) } },
      "/workspaces/{id}/agents/{label}/abort": { post: { summary: "Abort the active agent turn", parameters: [workspaceId, agentLabel], responses: jsonResponse("Agent aborted", { type: "object" }) } },
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, availableCommands: { type: "array", items: { type: "string" } } } } },
        },
        CreateWorkspace: {
          type: "object",
          properties: {
            source: { oneOf: [
              { type: "object", properties: { type: { const: "empty" } }, additionalProperties: false },
              { type: "object", required: ["type", "project"], properties: { type: { const: "project" }, project: { type: "string" } }, additionalProperties: false },
            ] },
            title: { type: "string" },
            agent: { type: "object", properties: { initialPrompt: { type: "string" }, model: { type: "string" }, thinkingLevel: { type: "string" }, serviceTier: { type: "string", enum: ["default", "priority"] }, attachmentDraft: { type: "string" } }, additionalProperties: false },
          },
          additionalProperties: false,
        },
        ProjectSummary: {
          type: "object",
          required: ["id", "name", "gitUrl", "branch", "sessionShareKey"],
          properties: projectSummaryProperties,
          additionalProperties: false,
        },
        ProjectEnvelope: { type: "object", required: ["project"], properties: { project: { $ref: "#/components/schemas/ProjectSummary" } } },
        EnvironmentVariable: {
          type: "object",
          required: ["id", "projectId", "name", "value", "createdAt", "updatedAt"],
          properties: { id: { type: "string" }, projectId: { type: "string" }, name: { type: "string" }, value: { type: "string" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" } },
          additionalProperties: false,
        },
        EnvironmentVariableInput: { type: "object", required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } }, additionalProperties: false },
        EnvironmentVariableEnvelope: { type: "object", required: ["environmentVariable"], properties: { environmentVariable: { $ref: "#/components/schemas/EnvironmentVariable" } } },
        SecretSummary: {
          type: "object",
          required: ["id", "projectId", "envName", "hostPattern", "createdAt", "updatedAt"],
          properties: { id: { type: "string" }, projectId: { type: "string" }, envName: { type: "string" }, hostPattern: { type: "string" }, placeholder: { type: "string" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" } },
          additionalProperties: false,
        },
        CreateSecret: { type: "object", required: ["envName", "hostPattern", "secretValue"], properties: { envName: { type: "string" }, hostPattern: { type: "string" }, placeholder: { type: "string" }, secretValue: { type: "string", writeOnly: true } }, additionalProperties: false },
        UpdateSecret: { type: "object", required: ["envName", "hostPattern"], properties: { envName: { type: "string" }, hostPattern: { type: "string" }, placeholder: { type: "string" }, secretValue: { type: "string", writeOnly: true } }, additionalProperties: false },
        SecretEnvelope: { type: "object", required: ["secret"], properties: { secret: { $ref: "#/components/schemas/SecretSummary" } } },
        ProjectConfigurationEnvelope: { type: "object", required: ["project"], properties: { project: {
          type: "object",
          required: ["id", "name", "gitUrl", "branch", "sessionShareKey", "environment", "secrets"],
          properties: { ...projectSummaryProperties, environment: { type: "array", items: { $ref: "#/components/schemas/EnvironmentVariable" } }, secrets: { type: "array", items: { $ref: "#/components/schemas/SecretSummary" } } },
          additionalProperties: false,
        } } },
        DeleteProjectResult: { oneOf: [
          { type: "object", required: ["deleted", "blocked", "project"], properties: { deleted: { const: true }, blocked: { const: false }, project: { $ref: "#/components/schemas/ProjectSummary" } } },
          { type: "object", required: ["deleted", "blocked", "references"], properties: { deleted: { const: false }, blocked: { const: true }, references: { type: "array", items: { type: "object", required: ["workspaceId", "title"], properties: { workspaceId: { type: "string" }, title: { type: "string" } }, additionalProperties: false } } } },
        ] },
        WorkspaceSummary: { type: "object", required: ["id", "title", "phase", "parked"], properties: { id: { type: "string" }, title: { type: "string" }, phase: { type: "string", enum: ["starting", "ready", "checking_delete", "deleting", "failed"] }, parked: { type: "boolean" }, projectId: { type: "string" } }, additionalProperties: false },
        WorkspaceEnvelope: {
          type: "object",
          required: ["workspace"],
          properties: { workspace: { type: "object", required: ["id", "phase", "url"], properties: {
            id: { type: "string" }, title: { type: "string" }, phase: { type: "string" }, url: { type: "string" }, error: { type: "string" },
            agentConversations: { type: "array", items: { type: "object", required: ["id", "title"], properties: { id: { type: "string", format: "uuid" }, title: { type: "string" } }, additionalProperties: false } },
            workViews: { type: "array", items: { $ref: "#/components/schemas/WorkView" } },
            commands: { type: "array", items: { type: "object" } },
          } } },
        },
        WorkViewReference: { type: "object", required: ["type"], properties: { type: { type: "string" } }, additionalProperties: true },
        WorkView: { type: "object", required: ["reference", "attention"], properties: { reference: { $ref: "#/components/schemas/WorkViewReference" }, attention: { type: "boolean" }, attentionSequence: { type: "integer" } }, additionalProperties: false },
        WorkViewsEnvelope: { type: "object", required: ["workViews"], properties: { workViews: { type: "array", items: { $ref: "#/components/schemas/WorkView" } } } },
        CommandResult: { type: "object", required: ["command", "workViews"], properties: { command: { type: "object" }, workViews: { type: "array", items: { $ref: "#/components/schemas/WorkView" } } } },
      },
    },
  };
}
