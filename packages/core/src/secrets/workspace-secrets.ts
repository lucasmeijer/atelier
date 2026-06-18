import { existsSync, readFileSync } from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultDataDir } from "../data-dir.ts";
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

function storedGitHubTokenPath(): string {
  return join(defaultDataDir(), "workspace", "github-token");
}

export function discoverHostGitHubToken(): string | undefined {
  const storedTokenPath = storedGitHubTokenPath();
  if (!existsSync(storedTokenPath)) return undefined;
  const token = readFileSync(storedTokenPath, "utf8").trim();
  return token || undefined;
}

export function hasWorkspaceGitHubToken(): boolean {
  return Boolean(discoverHostGitHubToken());
}

export function setWorkspaceGitHubToken(token: string): void {
  const path = storedGitHubTokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token.trim()}\n`, { mode: 0o600 });
  contexts.clear();
}

export function clearWorkspaceGitHubToken(): void {
  rmSync(storedGitHubTokenPath(), { force: true });
  contexts.clear();
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
