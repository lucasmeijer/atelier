import { emptyWorkspaceCommandInputSchema, type WorkspaceModuleCommandHandler } from "@atelier/shared";
import type { TSchema } from "typebox";
import { closeWorkViewRequestSchema, reorderWorkViewRequestSchema, workViewReferenceSchema } from "./work-view-api.ts";

const errorResponse = {
  description: "Request failed",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const jsonResponse = (description: string, schema: TSchema, status = "200") => ({
  [status]: { description, content: { "application/json": { schema } } },
  "400": errorResponse,
  "404": errorResponse,
});
const jsonAndHtmlResponse = (description: string, schema: TSchema) => ({
  ...jsonResponse(description, schema),
  "200": { description, content: { "application/json": { schema }, "text/html": { schema: { type: "string" } } } },
});
const workspaceId = { name: "id", in: "path", required: true, schema: { type: "string" } };
const agentConversation = { name: "agent", in: "query", required: false, description: "Agent conversation to select in the browser surface.", schema: { type: "string" } };
const selectedWorkView = { name: "workView", in: "query", required: false, description: "Work-view key to select and reveal in the browser surface.", schema: { type: "string" } };
const projectId = { name: "projectId", in: "path", required: true, schema: { type: "string" } };
const variableId = { name: "variableId", in: "path", required: true, schema: { type: "string" } };
const secretId = { name: "secretId", in: "path", required: true, schema: { type: "string" } };
const projectSettingsSection = { name: "section", in: "query", required: false, schema: { type: "string", enum: ["repository", "secrets", "ssh-keys", "environment", "danger"] } };
const settingsSection = { name: "section", in: "query", required: false, schema: { type: "string" } };
const htmlSurfaceResponses = (description: string) => ({ "200": { description, content: { "text/html": { schema: { type: "string" } } } }, "400": errorResponse, "404": errorResponse });
const agentConversationId = { name: "conversationId", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const attentionTokens = { name: "attentionTokens", in: "query", required: true, description: "JSON object mapping every captured Agent, Work-view, and Workspace Attention key to its occurrence token.", schema: { type: "string" } };
const jsonBody = (schema: TSchema) => ({ required: true, content: { "application/json": { schema } } });
const emptyObjectSchema = { type: "object", additionalProperties: false };
const projectSummaryProperties = { id: { type: "string" }, name: { type: "string" }, gitUrl: { type: "string" }, branch: { type: ["string", "null"] }, sessionShareKey: { type: "string" } };
const agentConversationSummarySchema = {
  type: "object",
  required: ["id", "title"],
  properties: { id: { type: "string", format: "uuid" }, title: { type: "string" } },
  additionalProperties: false,
};

export function atelierOpenApi(commands: WorkspaceModuleCommandHandler[]) {
  const commandSchemas = Object.fromEntries(commands.map((command) => [command.id, command.inputSchema ?? emptyWorkspaceCommandInputSchema]));
  const closeAgentConversationPath = { post: {
    summary: "Archive an Agent conversation",
    parameters: [workspaceId, agentConversationId],
    responses: {
      ...jsonResponse("Agent conversation archived", { $ref: "#/components/schemas/AgentConversationCloseResult" }),
      "409": { description: "The last Agent conversation cannot be archived", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
  } };
  const agentMessageResponses = {
    ...jsonResponse("Message accepted", { $ref: "#/components/schemas/AgentStateEnvelope" }, "202"),
    "200": { description: "Agent command completed", content: { "application/json": { schema: { $ref: "#/components/schemas/AgentStateEnvelope" } } } },
    "422": { description: "The submission has no prompt or completed attachment", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Atelier automation interface",
      version: "1.0.0",
      description: "JSON representations of Atelier's content-negotiated UI operations. Send Accept: application/json.",
    },
    paths: {
      "/design-system-catalogue.html": { get: { summary: "Browse design-system components, usage and edge-case playgrounds", responses: { "200": { description: "Server-rendered package catalogue", content: { "text/html": { schema: { type: "string" } } } } } } },
      "/up": { get: { summary: "Health check", responses: { "200": { description: "Atelier is healthy", content: { "text/plain": { schema: { type: "string" } } } } } } },
      "/workspaces": {
        get: { summary: "List workspaces", responses: jsonResponse("Workspace summaries", { type: "object", required: ["workspaces"], properties: { workspaces: { type: "array", items: { $ref: "#/components/schemas/WorkspaceSummary" } } } }) },
        post: { summary: "Create a workspace asynchronously", requestBody: jsonBody({ $ref: "#/components/schemas/CreateWorkspace" }), responses: jsonResponse("Workspace creation accepted", { $ref: "#/components/schemas/WorkspaceEnvelope" }, "202") },
      },
      "/projects": {
        get: { summary: "List projects", responses: jsonResponse("Project summaries", { type: "object", required: ["projects"], properties: { projects: { type: "array", items: { $ref: "#/components/schemas/ProjectSummary" } } } }) },
        post: { summary: "Create or resolve a project", description: "Creates a project, or resolves and returns the existing project when the same repository specification was previously added.", requestBody: jsonBody({ type: "object", required: ["gitUrl"], properties: { gitUrl: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Project created or resolved", { $ref: "#/components/schemas/ProjectEnvelope" }) },
      },
      "/projects/new": { get: { summary: "Present the new-project screen", responses: htmlSurfaceResponses("Atelier with the new-project screen open") } },
      "/workspaces/new": { get: { summary: "Present the new projectless workspace composer", responses: htmlSurfaceResponses("Atelier with the workspace composer open") } },
      "/settings": { get: { summary: "Present Atelier settings", parameters: [settingsSection], responses: htmlSurfaceResponses("Atelier with settings open") } },
      "/projects/{projectId}": {
        get: { summary: "Inspect project configuration", parameters: [projectId], responses: jsonResponse("Project configuration", { $ref: "#/components/schemas/ProjectConfigurationEnvelope" }) },
        post: { summary: "Update a project", parameters: [projectId], requestBody: jsonBody({ type: "object", required: ["name", "gitUrl"], properties: { name: { type: "string" }, gitUrl: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Project updated", { $ref: "#/components/schemas/ProjectEnvelope" }) },
      },
      "/projects/{projectId}/settings": {
        get: {
          summary: "Present project settings",
          description: "A browser-navigable Atelier surface. Use its URL with the presentation tool.",
          parameters: [projectId, projectSettingsSection],
          responses: htmlSurfaceResponses("Atelier with project settings open"),
        },
      },
      "/projects/{projectId}/workspaces/new": { get: { summary: "Present a new project workspace composer", parameters: [projectId], responses: htmlSurfaceResponses("Atelier with the project workspace composer open") } },
      "/projects/{projectId}/environment": { post: { summary: "Create a project environment variable", parameters: [projectId], requestBody: jsonBody({ $ref: "#/components/schemas/EnvironmentVariableInput" }), responses: jsonResponse("Environment variable created", { $ref: "#/components/schemas/EnvironmentVariableEnvelope" }) } },
      "/projects/{projectId}/environment/{variableId}": { post: { summary: "Update a project environment variable", parameters: [projectId, variableId], requestBody: jsonBody({ $ref: "#/components/schemas/EnvironmentVariableInput" }), responses: jsonResponse("Environment variable updated", { $ref: "#/components/schemas/EnvironmentVariableEnvelope" }) } },
      "/projects/{projectId}/environment/{variableId}/delete": { post: { summary: "Delete a project environment variable", parameters: [projectId, variableId], requestBody: jsonBody(emptyObjectSchema), responses: jsonResponse("Environment variable deleted", { type: "object", required: ["deleted", "environmentVariable"], properties: { deleted: { const: true }, environmentVariable: { $ref: "#/components/schemas/EnvironmentVariable" } } }) } },
      "/projects/{projectId}/secrets": { post: { summary: "Create a project secret", description: "The secretValue is encrypted and is never returned.", parameters: [projectId], requestBody: jsonBody({ $ref: "#/components/schemas/CreateSecret" }), responses: jsonResponse("Secret metadata created", { $ref: "#/components/schemas/SecretEnvelope" }) } },
      "/projects/{projectId}/secrets/{secretId}": { post: { summary: "Update a project secret", description: "Omit secretValue to preserve the stored secret. The value is never returned.", parameters: [projectId, secretId], requestBody: jsonBody({ $ref: "#/components/schemas/UpdateSecret" }), responses: jsonResponse("Secret metadata updated", { $ref: "#/components/schemas/SecretEnvelope" }) } },
      "/projects/{projectId}/secrets/{secretId}/delete": { post: { summary: "Delete a project secret", parameters: [projectId, secretId], requestBody: jsonBody(emptyObjectSchema), responses: jsonResponse("Secret deleted", { type: "object", required: ["deleted", "secret"], properties: { deleted: { const: true }, secret: { $ref: "#/components/schemas/SecretSummary" } } }) } },
      "/projects/{projectId}/delete": { post: { summary: "Delete a project", parameters: [projectId], requestBody: jsonBody(emptyObjectSchema), responses: jsonResponse("Project deleted or blocked by workspace references", { $ref: "#/components/schemas/DeleteProjectResult" }) } },
      "/workspaces/{id}": { get: { summary: "Inspect or present a workspace", description: "JSON requests inspect workspace state. Browser navigation presents the workspace and can select an Agent conversation or Work view.", parameters: [workspaceId, agentConversation, selectedWorkView], responses: jsonAndHtmlResponse("Workspace state or browser surface", { $ref: "#/components/schemas/WorkspaceEnvelope" }) } },
      "/workspaces/{id}/attention/acknowledge": { post: { summary: "Acknowledge all Attention captured when selecting a Workspace", parameters: [workspaceId, attentionTokens], responses: { "204": { description: "Captured Attention acknowledged; newer occurrences preserved" }, "400": errorResponse, "404": errorResponse } } },
      "/workspaces/{id}/sidebar-title": { post: { summary: "Rename a workspace", parameters: [workspaceId], requestBody: jsonBody({ type: "object", required: ["title"], properties: { title: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Workspace renamed", { $ref: "#/components/schemas/WorkspaceEnvelope" }) } },
      "/workspaces/{id}/provisioning/continue": { post: { summary: "Continue workspace provisioning after acknowledging a recoverable failure", parameters: [workspaceId], responses: { ...jsonResponse("Workspace provisioning resumed", { type: "object", required: ["continued", "stepId"], properties: { continued: { const: true }, stepId: { type: "string" } }, additionalProperties: false }), "409": errorResponse } } },
      "/workspaces/{id}/commands/{commandId}": { post: { summary: "Execute a workspace command", parameters: [workspaceId, { name: "commandId", in: "path", required: true, schema: { type: "string", enum: Object.keys(commandSchemas) } }], requestBody: jsonBody({ anyOf: Object.values(commandSchemas) }), responses: jsonResponse("Command executed", { $ref: "#/components/schemas/CommandResult" }), "x-atelier-command-schemas": commandSchemas } },
      "/workspaces/{id}/browser/{browserId}/navigate": { post: { summary: "Navigate a Browser Work view", parameters: [workspaceId, { name: "browserId", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ type: "object", required: ["url"], properties: { url: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Browser navigated", { type: "object" }) } },
      "/workspaces/{id}/work-views/reorder": { post: { summary: "Reorder a typed Work view", parameters: [workspaceId], requestBody: jsonBody(reorderWorkViewRequestSchema), responses: jsonResponse("Work views reordered", { $ref: "#/components/schemas/WorkViewsEnvelope" }) } },
      "/workspaces/{id}/work-views/{key}/attention/request": { post: { summary: "Present a Work view and request Attention", parameters: [workspaceId, { name: "key", in: "path", required: true, schema: { type: "string" } }], responses: jsonResponse("Attention requested", { type: "object" }) } },
      "/workspaces/{id}/work-views/close": { post: { summary: "Close a typed Work view", parameters: [workspaceId], requestBody: jsonBody(closeWorkViewRequestSchema), responses: jsonResponse("Work view closed", { $ref: "#/components/schemas/WorkViewsEnvelope" }) } },
      "/workspaces/{id}/agents/{conversationId}/close": closeAgentConversationPath,
      "/workspaces/{id}/park": { post: { summary: "Park a workspace", parameters: [workspaceId], responses: jsonResponse("Workspace parked", { type: "object" }) } },
      "/workspaces/{id}/unpark": { post: { summary: "Unpark a workspace", parameters: [workspaceId], responses: jsonResponse("Workspace unparked", { type: "object" }) } },
      "/workspaces/{id}/delete": { post: { summary: "Delete a workspace", parameters: [workspaceId], requestBody: jsonBody({ type: "object", properties: { force: { type: "boolean" } }, additionalProperties: false }), responses: jsonResponse("Workspace deletion scheduled or blocked", { type: "object" }) } },
      "/workspaces/{id}/agents/{conversationId}/messages": { post: { summary: "Submit or steer an agent message", parameters: [workspaceId, agentConversationId], requestBody: jsonBody({ type: "object", required: ["text"], properties: { text: { type: "string" }, mode: { type: "string", enum: ["send", "steer"] } }, additionalProperties: false }), responses: agentMessageResponses } },
      "/workspaces/{id}/agents/{conversationId}/model": { post: { summary: "Select an agent model", parameters: [workspaceId, agentConversationId], requestBody: jsonBody({ type: "object", required: ["model"], properties: { model: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Model selected", { $ref: "#/components/schemas/AgentModelEnvelope" }) } },
      "/workspaces/{id}/agents/{conversationId}/thinking": { post: { summary: "Select an agent thinking level", parameters: [workspaceId, agentConversationId], requestBody: jsonBody({ type: "object", required: ["level"], properties: { level: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Thinking level selected", { $ref: "#/components/schemas/AgentThinkingEnvelope" }) } },
      "/workspaces/{id}/agents/{conversationId}/service-tier": { post: { summary: "Select an agent inference service tier", parameters: [workspaceId, agentConversationId], requestBody: jsonBody({ type: "object", required: ["serviceTier"], properties: { serviceTier: { type: "string", enum: ["default", "priority"] } }, additionalProperties: false }), responses: jsonResponse("Service tier selected", { $ref: "#/components/schemas/AgentServiceTierEnvelope" }) } },
      "/workspaces/{id}/agents/{conversationId}/abort": { post: { summary: "Abort the active agent turn", parameters: [workspaceId, agentConversationId], responses: jsonResponse("Agent aborted", { $ref: "#/components/schemas/AgentStateEnvelope" }) } },
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
            agentConversations: { type: "array", items: { $ref: "#/components/schemas/AgentConversationSummary" } },
            workViews: { type: "array", items: { $ref: "#/components/schemas/PresentedWorkView" } },
            commands: { type: "array", items: { type: "object" } },
          } } },
        },
        AgentConversationSummary: agentConversationSummarySchema,
        AgentConversationCloseResult: {
          type: "object",
          required: ["archivedConversationId", "agentConversations"],
          properties: {
            archivedConversationId: { type: "string", format: "uuid" },
            agentConversations: { type: "array", items: { $ref: "#/components/schemas/AgentConversationSummary" } },
          },
          additionalProperties: false,
        },
        AgentStateEnvelope: {
          type: "object",
          required: ["agent"],
          properties: { agent: {
            type: "object",
            required: ["conversationId", "state"],
            properties: {
              conversationId: { type: "string", format: "uuid" },
              state: { type: "string", enum: ["idle", "running"] },
              aborted: { type: "boolean" },
              compacted: { type: "boolean" },
            },
            additionalProperties: false,
          } },
          additionalProperties: false,
        },
        AgentModelEnvelope: {
          type: "object",
          required: ["agent"],
          properties: { agent: { type: "object", required: ["conversationId", "model"], properties: { conversationId: { type: "string", format: "uuid" }, model: { type: "string" } }, additionalProperties: false } },
          additionalProperties: false,
        },
        AgentThinkingEnvelope: {
          type: "object",
          required: ["agent"],
          properties: { agent: { type: "object", required: ["conversationId", "thinkingLevel"], properties: { conversationId: { type: "string", format: "uuid" }, thinkingLevel: { type: "string" } }, additionalProperties: false } },
          additionalProperties: false,
        },
        AgentServiceTierEnvelope: {
          type: "object",
          required: ["agent"],
          properties: { agent: { type: "object", required: ["conversationId", "serviceTier"], properties: { conversationId: { type: "string", format: "uuid" }, serviceTier: { type: "string", enum: ["default", "priority"] } }, additionalProperties: false } },
          additionalProperties: false,
        },
        WorkViewReference: workViewReferenceSchema,
        WorkView: { type: "object", required: ["reference", "attention"], properties: { reference: { $ref: "#/components/schemas/WorkViewReference" }, attention: { type: "boolean" }, attentionSequence: { type: "integer" } }, additionalProperties: false },
        PresentedWorkView: { type: "object", required: ["key", "reference", "attention"], properties: { key: { type: "string" }, reference: { $ref: "#/components/schemas/WorkViewReference" }, attention: { type: "boolean" }, attentionSequence: { type: "integer" } }, additionalProperties: false },
        WorkViewsEnvelope: { type: "object", required: ["workViews"], properties: { workViews: { type: "array", items: { $ref: "#/components/schemas/WorkView" } } } },
        CommandResult: { type: "object", required: ["command", "workViews"], properties: {
          command: { type: "object", required: ["id"], properties: { id: { type: "string" }, workView: { $ref: "#/components/schemas/WorkViewReference" }, agentConversationId: { type: "string", format: "uuid" } }, additionalProperties: false },
          workViews: { type: "array", items: { $ref: "#/components/schemas/WorkView" } },
        }, additionalProperties: false },
      },
    },
  };
}
