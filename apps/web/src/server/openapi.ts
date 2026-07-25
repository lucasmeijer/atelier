import { emptyWorkspaceCommandInputSchema, type WorkspaceModuleCommandHandler } from "@atelier/shared";

const errorResponse = {
  description: "Request failed",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const jsonResponse = (description: string, schema: unknown, status = "200") => ({
  [status]: { description, content: { "application/json": { schema } } },
  "400": errorResponse,
  "404": errorResponse,
});
const workspaceId = { name: "id", in: "path", required: true, schema: { type: "string" } };
const groupId = { name: "groupId", in: "path", required: true, schema: { type: "string" } };
const agentLabel = { name: "label", in: "path", required: true, schema: { type: "string" } };
const jsonBody = (schema: unknown) => ({ required: true, content: { "application/json": { schema } } });

export function atelierOpenApi(commands: WorkspaceModuleCommandHandler[]): Record<string, unknown> {
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
      "/workspaces": { post: { summary: "Create a workspace asynchronously", requestBody: jsonBody({ $ref: "#/components/schemas/CreateWorkspace" }), responses: jsonResponse("Workspace creation accepted", { $ref: "#/components/schemas/WorkspaceEnvelope" }, "202") } },
      "/workspaces/{id}": { get: { summary: "Inspect workspace readiness, tabs, commands, and layout", parameters: [workspaceId], responses: jsonResponse("Workspace state", { $ref: "#/components/schemas/WorkspaceEnvelope" }) } },
      "/workspaces/{id}/sidebar-title": { post: { summary: "Rename a workspace", parameters: [workspaceId], requestBody: jsonBody({ type: "object", required: ["title"], properties: { title: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Workspace renamed", { $ref: "#/components/schemas/WorkspaceEnvelope" }) } },
      "/workspaces/{id}/commands/{commandId}": { post: { summary: "Execute a workspace command", parameters: [workspaceId, { name: "commandId", in: "path", required: true, schema: { type: "string", enum: Object.keys(commandSchemas) } }], requestBody: jsonBody({ anyOf: Object.values(commandSchemas) }), responses: jsonResponse("Command executed", { $ref: "#/components/schemas/CommandResult" }), "x-atelier-command-schemas": commandSchemas } },
      "/workspaces/{id}/groups/{groupId}/commands/{commandId}": { post: { summary: "Execute a command in a layout group", parameters: [workspaceId, groupId, { name: "commandId", in: "path", required: true, schema: { type: "string", enum: Object.keys(commandSchemas) } }], requestBody: jsonBody({ anyOf: Object.values(commandSchemas) }), responses: jsonResponse("Command executed", { $ref: "#/components/schemas/CommandResult" }), "x-atelier-command-schemas": commandSchemas } },
      "/workspaces/{id}/browser/{tabKey}/navigate": { post: { summary: "Navigate a browser tab", parameters: [workspaceId, { name: "tabKey", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ type: "object", required: ["url"], properties: { url: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Browser navigated", { type: "object" }) } },
      "/workspaces/{id}/view-state": { post: { summary: "Select the visible tab in a group", parameters: [workspaceId], requestBody: jsonBody({ type: "object", required: ["groupId", "visibleTab"], properties: { groupId: { type: "string" }, visibleTab: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Visible tab selected", { $ref: "#/components/schemas/LayoutEnvelope" }) } },
      "/workspaces/{id}/layout/move-tab": { post: { summary: "Move a tab", parameters: [workspaceId], requestBody: jsonBody({ type: "object", required: ["tab"], properties: { tab: { type: "string" }, toGroup: { type: "string" }, toIndex: { type: "integer" }, newGroup: { type: "boolean" } }, additionalProperties: false }), responses: jsonResponse("Tab moved", { $ref: "#/components/schemas/LayoutEnvelope" }) } },
      "/workspaces/{id}/layout/resize": { post: { summary: "Resize layout groups", parameters: [workspaceId], requestBody: jsonBody({ type: "object", required: ["sizes"], properties: { sizes: { type: "array", items: { type: "number", exclusiveMinimum: 0 } } }, additionalProperties: false }), responses: jsonResponse("Groups resized", { $ref: "#/components/schemas/LayoutEnvelope" }) } },
      "/workspaces/{id}/groups/{groupId}/split": { post: { summary: "Create a layout group", parameters: [workspaceId, groupId], responses: jsonResponse("Group created", { $ref: "#/components/schemas/LayoutEnvelope" }) } },
      "/workspaces/{id}/groups/{groupId}/remove": { post: { summary: "Remove an empty layout group", parameters: [workspaceId, groupId], responses: jsonResponse("Group removed", { $ref: "#/components/schemas/LayoutEnvelope" }) } },
      "/workspaces/{id}/groups/{groupId}/close": { post: { summary: "Close a layout group", parameters: [workspaceId, groupId], responses: jsonResponse("Group closed", { $ref: "#/components/schemas/LayoutEnvelope" }) } },
      "/workspaces/{id}/tabs/{tabKey}/close": { post: { summary: "Close a workspace tab", parameters: [workspaceId, { name: "tabKey", in: "path", required: true, schema: { type: "string" } }], responses: jsonResponse("Tab closed", { $ref: "#/components/schemas/LayoutEnvelope" }) } },
      "/workspaces/{id}/park": { post: { summary: "Park a workspace", parameters: [workspaceId], responses: jsonResponse("Workspace parked", { type: "object" }) } },
      "/workspaces/{id}/unpark": { post: { summary: "Unpark a workspace", parameters: [workspaceId], responses: jsonResponse("Workspace unparked", { type: "object" }) } },
      "/workspaces/{id}/delete": { post: { summary: "Delete a workspace", parameters: [workspaceId], requestBody: jsonBody({ type: "object", properties: { force: { type: "boolean" } }, additionalProperties: false }), responses: jsonResponse("Workspace deletion scheduled or blocked", { type: "object" }) } },
      "/workspaces/{id}/agents/{label}/messages": { post: { summary: "Submit or steer an agent message", parameters: [workspaceId, agentLabel], requestBody: jsonBody({ type: "object", required: ["text"], properties: { text: { type: "string" }, mode: { type: "string", enum: ["send", "steer"] } }, additionalProperties: false }), responses: jsonResponse("Message accepted", { type: "object" }, "202") } },
      "/workspaces/{id}/agents/{label}/model": { post: { summary: "Select an agent model", parameters: [workspaceId, agentLabel], requestBody: jsonBody({ type: "object", required: ["model"], properties: { model: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Model selected", { type: "object" }) } },
      "/workspaces/{id}/agents/{label}/thinking": { post: { summary: "Select an agent thinking level", parameters: [workspaceId, agentLabel], requestBody: jsonBody({ type: "object", required: ["level"], properties: { level: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Thinking level selected", { type: "object" }) } },
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
            agent: { type: "object", properties: { initialPrompt: { type: "string" }, model: { type: "string" }, thinkingLevel: { type: "string" }, attachmentDraft: { type: "string" } }, additionalProperties: false },
          },
          additionalProperties: false,
        },
        WorkspaceEnvelope: {
          type: "object",
          required: ["workspace"],
          properties: { workspace: { type: "object", required: ["id", "phase", "url"], properties: {
            id: { type: "string" }, title: { type: "string" }, phase: { type: "string" }, url: { type: "string" }, error: { type: "string" },
            tabs: { type: "array", items: { type: "object", required: ["key", "label"], properties: { key: { type: "string" }, label: { type: "string" } } } },
            commands: { type: "array", items: { type: "object" } }, layout: { $ref: "#/components/schemas/Layout" },
          } } },
        },
        Layout: { type: "object", required: ["groups"], properties: { groups: { type: "array", items: { type: "object" } }, closedTabs: { type: "array", items: { type: "string" } } } },
        LayoutEnvelope: { type: "object", required: ["layout"], properties: { layout: { $ref: "#/components/schemas/Layout" }, createdGroupId: { type: "string" } } },
        CommandResult: { type: "object", required: ["command"], properties: { command: { type: "object" }, layout: { $ref: "#/components/schemas/Layout" } } },
      },
    },
  };
}
