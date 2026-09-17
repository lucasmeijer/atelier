import { clearWorkspaceGitHubToken as clearStoredWorkspaceGitHubToken, discoverHostGitHubToken, hasWorkspaceGitHubToken as hasStoredWorkspaceGitHubToken, setWorkspaceGitHubToken as setStoredWorkspaceGitHubToken } from "@atelier/core";
import { isGitProjectInit, revealProjectSecrets, onProjectStoreChanged, projectSecretPlaceholder, projectSecretHosts } from "@atelier/projects";
import { getWorkspaceInit, type WorkspaceInitInstruction } from "@atelier/workspace";
import { createHttpHooks, type RequestTransformHttpHooks, type SecretDefinition } from "./placeholder-hooks.ts";

export const githubTokenEnvVar = "GH_TOKEN";

export type WorkspaceSecretContext = {
  workspaceId: string;
  env: Record<string, string>;
  hooks: RequestTransformHttpHooks;
  secrets: Array<{ name: string; placeholder: string; hosts: string[] }>;
};

const subscriptionSecrets: Record<string, SecretDefinition> = {};

export function registerWorkspaceSubscriptionSecrets(secrets: Record<string, SecretDefinition>): void {
  Object.assign(subscriptionSecrets, secrets);
  invalidateContexts();
}

const contexts = new Map<string, WorkspaceSecretContext>();
let configurationGeneration = 0;
// New requests reload hooks; existing raw CONNECT tunnels still require client reconnection.
function invalidateContexts(): void {
  configurationGeneration++;
  contexts.clear();
}
onProjectStoreChanged(invalidateContexts);

export { discoverHostGitHubToken };

export function hasWorkspaceGitHubToken(): boolean {
  return hasStoredWorkspaceGitHubToken();
}

export function setWorkspaceGitHubToken(token: string): void {
  setStoredWorkspaceGitHubToken(token);
  invalidateContexts();
}

export function clearWorkspaceGitHubToken(): void {
  clearStoredWorkspaceGitHubToken();
  invalidateContexts();
}

export async function createWorkspaceSecretContext(workspaceId: string, init?: WorkspaceInitInstruction): Promise<WorkspaceSecretContext> {
  const existing = contexts.get(workspaceId);
  if (existing) return existing;

  const generation = configurationGeneration;
  const token = discoverHostGitHubToken();
  const secrets: Record<string, SecretDefinition> = token
    ? { [githubTokenEnvVar]: { value: token, hosts: githubAllowedHosts(), placeholder: projectSecretPlaceholder(githubTokenEnvVar) } }
    : {};
  if (isGitProjectInit(init)) {
    for (const secret of await revealProjectSecrets(init.projectId)) {
      secrets[secret.envName] = { value: secret.secretValue, hosts: projectSecretHosts(secret.hostPattern), placeholder: secret.placeholder ?? projectSecretPlaceholder(secret.envName) };
    }
  }
  if (generation !== configurationGeneration) return createWorkspaceSecretContext(workspaceId, init);
  const created = buildContext(workspaceId, { ...secrets, ...subscriptionSecrets });
  contexts.set(workspaceId, created);
  return created;
}

export async function getWorkspaceSecretContext(
  workspaceId: string,
  loadWorkspaceInit: (workspaceId: string) => Promise<WorkspaceInitInstruction | undefined> = getWorkspaceInit,
): Promise<WorkspaceSecretContext> {
  const existing = contexts.get(workspaceId);
  if (existing) return existing;
  return await createWorkspaceSecretContext(workspaceId, await loadWorkspaceInit(workspaceId));
}

export function forgetWorkspaceSecretContext(workspaceId: string): void {
  contexts.delete(workspaceId);
}

function buildContext(workspaceId: string, secrets: Record<string, SecretDefinition>): WorkspaceSecretContext {
  const hooks = createHttpHooks({
    allowedHosts: ["*"],
    blockInternalRanges: true,
    replaceSecretsInPath: true,
    replaceSecretsInQuery: false,
    secrets,
  });
  return {
    workspaceId,
    env: Object.fromEntries(Object.entries(hooks.env).filter(([name]) => !(name in subscriptionSecrets))),
    hooks: hooks.httpHooks,
    secrets: hooks.secrets,
  };
}

function githubAllowedHosts(): string[] {
  return ["github.com", "api.github.com"];
}
