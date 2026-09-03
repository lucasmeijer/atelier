import { clearWorkspaceGitHubToken as clearStoredWorkspaceGitHubToken, discoverHostGitHubToken, hasWorkspaceGitHubToken as hasStoredWorkspaceGitHubToken, setWorkspaceGitHubToken as setStoredWorkspaceGitHubToken } from "@atelier/core";
import { isGitProjectInit, revealProjectSecrets } from "@atelier/projects";
import { getWorkspaceInit, type WorkspaceInitInstruction } from "@atelier/workspace";
import { createHttpHooks, type RequestTransformHttpHooks, type SecretDefinition } from "./placeholder-hooks.ts";

export const githubTokenEnvVar = "GH_TOKEN";

export type WorkspaceSecretContext = {
  workspaceId: string;
  env: Record<string, string>;
  hooks: RequestTransformHttpHooks;
  secrets: Array<{ name: string; placeholder: string; hosts: string[] }>;
};

const contexts = new Map<string, WorkspaceSecretContext>();

export { discoverHostGitHubToken };

export function hasWorkspaceGitHubToken(): boolean {
  return hasStoredWorkspaceGitHubToken();
}

export function setWorkspaceGitHubToken(token: string): void {
  setStoredWorkspaceGitHubToken(token);
  contexts.clear();
}

export function clearWorkspaceGitHubToken(): void {
  clearStoredWorkspaceGitHubToken();
  contexts.clear();
}

export async function createWorkspaceSecretContext(workspaceId: string, init?: WorkspaceInitInstruction): Promise<WorkspaceSecretContext> {
  const existing = contexts.get(workspaceId);
  if (existing) return existing;

  const token = discoverHostGitHubToken();
  const secrets: Record<string, SecretDefinition> = token
    ? { [githubTokenEnvVar]: { value: token, hosts: githubAllowedHosts(), placeholder: secretPlaceholder(githubTokenEnvVar) } }
    : {};
  if (isGitProjectInit(init)) {
    for (const secret of await revealProjectSecrets(init.projectId)) {
      secrets[secret.envName] = { value: secret.secretValue, hosts: parseHostPatterns(secret.hostPattern), placeholder: secret.placeholder ?? secretPlaceholder(secret.envName) };
    }
  }
  const created = buildContext(workspaceId, secrets);
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
    blockInternalRanges: false,
    replaceSecretsInPath: true,
    replaceSecretsInQuery: false,
    secrets,
  });
  return {
    workspaceId,
    env: hooks.env,
    hooks: hooks.httpHooks,
    secrets: hooks.secrets,
  };
}

function secretPlaceholder(name: string): string {
  return `ATELIER_PROXY_READY_${name.replaceAll(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`;
}

function parseHostPatterns(hostPattern: string): string[] {
  return hostPattern.split(",").map((part) => part.trim()).filter(Boolean);
}

function githubAllowedHosts(): string[] {
  return ["github.com", "api.github.com"];
}
