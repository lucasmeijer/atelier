import { invalidArguments } from "@atelier/core";
import { createProjectSecret, listProjectSecrets, updateProjectSecret, type ProjectSecretSummary } from "@atelier/projects";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { createApprovalRequests } from "./approval-requests.ts";

export const secretSuggestionSchema = Type.Object({
  envName: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
  hostPattern: Type.String({ minLength: 1 }),
  placeholder: Type.Optional(Type.String()),
  annotation: Type.String({ description: "A succinct explanation of what the app uses this secret for." }),
  optional: Type.Boolean({ description: "Only mark secrets as mandatory (optional: false) if the app will not start or do anything useful without them. Otherwise mark them as optional (optional: true)." }),
}, { additionalProperties: false });
export type SecretSuggestion = Static<typeof secretSuggestionSchema>;
export interface SecretRequestResult {
  secret: ProjectSecretSummary;
  valueProvided: boolean;
  changedFields: string[];
}
export interface PendingSecretRequest {
  id: string;
  workspaceId: string;
  projectId: string;
  suggestion: SecretSuggestion;
  existing?: ProjectSecretSummary;
}
/** Holds a tool call open until a user saves or defers the individual secret. Values never enter the pending request or tool result. */
export function createSecretRequests(changed: (workspaceId: string) => void) {
  const approvals = createApprovalRequests<Omit<PendingSecretRequest, "id" | "workspaceId">, SecretRequestResult>(changed);
  return {
    forWorkspace: approvals.forWorkspace,
    byId: approvals.byId,
    cancelWorkspace: approvals.cancelWorkspace,
    async request(workspaceId: string, projectId: string, suggestion: SecretSuggestion, signal?: AbortSignal): Promise<SecretRequestResult> {
      Value.Assert(secretSuggestionSchema, suggestion);
      signal?.throwIfAborted();
      const existing = (await listProjectSecrets(projectId)).find((secret) => secret.envName === suggestion.envName);
      return approvals.wait(workspaceId, { projectId, suggestion, existing }, signal);
    },
    async complete(id: string, settings: SecretSuggestion, decision: "save" | "skip", secretValue: string): Promise<SecretRequestResult> {
      return approvals.answer(id, async (request) => {
        if (!Value.Check(secretSuggestionSchema, settings)) throw invalidArguments("Check the secret's environment variable name and host.");
        if (decision === "save" && !secretValue.length) throw invalidArguments("Enter a secret value before saving, or choose to set it up later.");
        const values = { ...settings, secretValue: decision === "save" ? secretValue : undefined };
        const secret = request.existing
          ? await updateProjectSecret(request.projectId, request.existing.id, values)
          : await createProjectSecret(request.projectId, values);
        const changedFields = (["envName", "hostPattern", "placeholder", "annotation", "optional"] as const)
          .filter((field) => (secret[field] ?? "") !== (request.suggestion[field] ?? ""));
        return { secret, valueProvided: decision === "save", changedFields };
      });
    },
  };
}
export type SecretRequests = ReturnType<typeof createSecretRequests>;
