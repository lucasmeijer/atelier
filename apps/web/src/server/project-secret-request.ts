import { AtelierCoreError } from "@atelier/core";
import { setTimeout as delay } from "node:timers/promises";
import { createProjectSecret, listProjectSecrets, projectSecretRoutingRevision, projectSecretPlaceholder, readProjectWorkspaceSettings, type ProjectSecretSummary } from "@atelier/projects";
import type { OnboardingToolDependencies, SecretValueRequest } from "@atelier/agent/server";

function requireMatchingSecret(secret: ProjectSecretSummary, expectedRoutingRevision: string): void {
  if (projectSecretRoutingRevision(secret) !== expectedRoutingRevision) {
    throw new AtelierCoreError("project_secret_configuration_conflict", `Secret ${secret.envName} already has different host restrictions or placeholder settings. Stored hosts: ${secret.hostPattern}; stored placeholder: ${secret.placeholder ?? projectSecretPlaceholder(secret.envName)}. Review project secrets rather than replacing its value for a different destination.`);
  }
}

/** Uses a focused, value-only secret dialog, never the agent transcript, for input. */
export function createProjectSecretRequester(deps: {
  list: typeof listProjectSecrets;
  create: typeof createProjectSecret;
  readSettings: typeof readProjectWorkspaceSettings;
  wait: (signal?: AbortSignal) => Promise<void>;
} = {
  list: listProjectSecrets,
  create: createProjectSecret,
  readSettings: readProjectWorkspaceSettings,
  wait: (signal) => delay(500, undefined, { signal }),
}): OnboardingToolDependencies["requestSecretValue"] {
  return async (projectId, request: SecretValueRequest, signal, onUpdate) => {
    signal?.throwIfAborted();
    const expectedRoutingRevision = projectSecretRoutingRevision(request);
    let secret = (await deps.list(projectId)).find((secret) => secret.envName === request.envName.trim());
    if (!secret) {
      secret = await deps.create(projectId, { envName: request.envName, hostPattern: request.hostPattern, placeholder: request.placeholder, annotation: request.purpose });
    }
    requireMatchingSecret(secret, expectedRoutingRevision);
    const initial = secret;
    const url = `/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(initial.id)}/value?purpose=${encodeURIComponent(request.purpose)}`;
    onUpdate?.({
      content: [{ type: "text", text: `${request.purpose}\n\n${initial.configured ? "Replace" : "Enter"} ${request.envName} using the secure dialog: ${url}\nStored destination restrictions: ${initial.hostPattern}. Save the value there, not in chat. It is saved to the project immediately. Reconnect existing clients before using it; open HTTPS tunnels are not reconfigured. Stop this tool to cancel waiting.` }],
      details: { status: "awaiting_user", envName: request.envName, secretRequestUrl: url },
    });
    while (true) {
      signal?.throwIfAborted();
      const current = (await deps.list(projectId)).find((candidate) => candidate.id === initial.id);
      if (!current) return { status: "cancelled", envName: request.envName };
      requireMatchingSecret(current, expectedRoutingRevision);
      if (current.valueRevision && current.valueRevision !== initial.valueRevision) {
        return {
          status: "saved", settingsRevision: (await deps.readSettings(projectId)).settingsRevision,
          envName: current.envName, placeholder: current.placeholder ?? projectSecretPlaceholder(current.envName),
          hostPattern: current.hostPattern, egressReplacement: "active_for_new_connections", reconnectRequired: true, existingProcessEnvironmentUpdated: false,
        };
      }
      await deps.wait(signal);
    }
  };
}
