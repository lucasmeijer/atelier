import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHttpHooks, type SecretDefinition, type SecretManager } from "./placeholder-hooks.ts";
import type { HttpHooks } from "./types.ts";

export const githubTokenEnvVar = "GH_TOKEN";

export type WorkspaceSecretContext = {
  workspaceId: string;
  env: Record<string, string>;
  hooks: HttpHooks;
  secretManager: SecretManager;
  secrets: Array<{ name: string; placeholder: string; hosts: string[] }>;
};

const contexts = new Map<string, WorkspaceSecretContext>();

export function discoverHostGitHubToken(): string | undefined {
  const envToken = process.env[githubTokenEnvVar];
  if (envToken) return envToken;
  const tokenPath = join(homedir(), githubTokenEnvVar);
  if (!existsSync(tokenPath)) return undefined;
  const token = readFileSync(tokenPath, "utf8").trim();
  return token || undefined;
}

export async function createWorkspaceSecretContext(workspaceId: string): Promise<WorkspaceSecretContext> {
  const existing = contexts.get(workspaceId);
  if (existing) return existing;

  const token = discoverHostGitHubToken();
  const secrets: Record<string, SecretDefinition> = token
    ? { [githubTokenEnvVar]: { value: token, hosts: githubAllowedHosts(), placeholder: secretPlaceholder(githubTokenEnvVar) } }
    : {};
  const created = buildContext(workspaceId, secrets);
  contexts.set(workspaceId, created);
  return created;
}

export async function getWorkspaceSecretContext(workspaceId: string): Promise<WorkspaceSecretContext | undefined> {
  return contexts.get(workspaceId) ?? await createWorkspaceSecretContext(workspaceId);
}

export function forgetWorkspaceSecretContext(workspaceId: string): void {
  contexts.delete(workspaceId);
}

function buildContext(workspaceId: string, secrets: Record<string, SecretDefinition>): WorkspaceSecretContext {
  const hooks = createHttpHooks({
    allowedHosts: ["*"],
    blockInternalRanges: false,
    replaceSecretsInQuery: false,
    secrets,
  });
  return {
    workspaceId,
    env: hooks.env,
    hooks: hooks.httpHooks,
    secretManager: hooks.secretManager,
    secrets: hooks.secretManager.listSecrets().map(({ name, placeholder, hosts }) => ({ name, placeholder, hosts })),
  };
}

function secretPlaceholder(name: string): string {
  return `ATELIER_INJECT_${name.replaceAll(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`;
}

function githubAllowedHosts(): string[] {
  return ["github.com", "api.github.com"];
}
