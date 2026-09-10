import { createProjectEnvironmentVariable, listProjectEnvironmentVariables, updateProjectEnvironmentVariable, type ProjectEnvironmentVariable } from "@atelier/projects";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { createApprovalRequests, type PendingApproval } from "./approval-requests.ts";

export const environmentSuggestionSchema = Type.Object({
  name: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
  value: Type.String({ description: "The suggested non-secret environment variable value. May be empty. Never use this tool for secrets." }),
}, { additionalProperties: false });
export type EnvironmentSuggestion = Static<typeof environmentSuggestionSchema>;
interface EnvironmentRequestDetails {
  projectId: string;
  suggestion: EnvironmentSuggestion;
  existing?: ProjectEnvironmentVariable;
}
export type PendingEnvironmentRequest = PendingApproval<EnvironmentRequestDetails>;
export interface EnvironmentRequestResult {
  saved: boolean;
  settings: EnvironmentSuggestion;
  changedFields: string[];
}

export function createEnvironmentRequests(changed: (workspaceId: string) => void) {
  const approvals = createApprovalRequests<EnvironmentRequestDetails, EnvironmentRequestResult>(changed);
  return {
    forWorkspace: approvals.forWorkspace,
    byId: approvals.byId,
    cancelWorkspace: approvals.cancelWorkspace,
    async request(workspaceId: string, projectId: string, suggestion: EnvironmentSuggestion, signal?: AbortSignal): Promise<EnvironmentRequestResult> {
      Value.Assert(environmentSuggestionSchema, suggestion);
      signal?.throwIfAborted();
      const existing = (await listProjectEnvironmentVariables(projectId)).find((variable) => variable.name === suggestion.name);
      return approvals.wait(workspaceId, { projectId, suggestion, existing }, signal);
    },
    async complete(id: string, settings: EnvironmentSuggestion, decision: "save" | "skip"): Promise<EnvironmentRequestResult> {
      return approvals.answer(id, async (request) => {
        let finalSettings = settings;
        if (decision === "save") {
          const variable = request.existing
            ? await updateProjectEnvironmentVariable(request.projectId, request.existing.id, settings)
            : await createProjectEnvironmentVariable(request.projectId, settings);
          finalSettings = { name: variable.name, value: variable.value };
        }
        return {
          saved: decision === "save",
          settings: finalSettings,
          changedFields: (["name", "value"] as const).filter((field) => finalSettings[field] !== request.suggestion[field]),
        };
      });
    },
  };
}
export type EnvironmentRequests = ReturnType<typeof createEnvironmentRequests>;
