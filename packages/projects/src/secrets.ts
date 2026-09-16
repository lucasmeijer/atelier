import { Type, type Static } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { AtelierCoreError } from "@atelier/core";
import { decryptProjectValue, encryptProjectValue } from "./secret-crypto.ts";
import { findProjectRecord, projectSecretSummary, projectSecretSummaries, projectsFile, readProjectStore, updateProjectStore, type ProjectRecord, type ProjectSecretSummary, type StoredProjectSecret } from "./project.ts";

export interface ProjectSecretPlaintext extends ProjectSecretSummary {
  secretValue: string;
}

export interface ProjectSecretInput {
  envName: string;
  hostPattern: string;
  placeholder?: string;
  annotation?: string;
  optional?: boolean;
  secretValue?: string;
}

export function secretNeedsValue(secret: ProjectSecretSummary): boolean {
  return !secret.optional && !secret.configured;
}

function normalizeEnvName(value: string): string {
  const envName = value.trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(envName)) throw new AtelierCoreError("invalid_arguments", "ENV must be an uppercase environment variable name");
  return envName;
}

function normalizeHostPattern(value: string): string {
  const hostPattern = value.trim().toLowerCase();
  if (!hostPattern) throw new AtelierCoreError("invalid_arguments", "HOST is required");
  return hostPattern;
}

function normalizePlaceholder(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function findProjectSecret(project: ProjectRecord, secretId: string): StoredProjectSecret {
  const secret = project.secrets?.find((candidate) => candidate.id === secretId);
  if (!secret) throw new AtelierCoreError("project_secret_not_found", `project secret not found: ${secretId}`);
  return secret;
}

function assertEnvNameAvailable(project: ProjectRecord, envName: string, exceptSecretId?: string): void {
  if (project.secrets?.some((secret) => secret.id !== exceptSecretId && secret.envName === envName)) throw new AtelierCoreError("project_secret_exists", "project secret already exists");
}

export async function listProjectSecrets(projectId: string, file = projectsFile()): Promise<ProjectSecretSummary[]> {
  const project = findProjectRecord(await readProjectStore(file), projectId);
  return projectSecretSummaries(project);
}

export async function createProjectSecret(projectId: string, values: ProjectSecretInput, file = projectsFile(), keyFile?: string): Promise<ProjectSecretSummary> {
  const envName = normalizeEnvName(values.envName);
  const hostPattern = normalizeHostPattern(values.hostPattern);
  const placeholder = normalizePlaceholder(values.placeholder);
  const secretValue = values.secretValue;
  return await updateProjectStore(file, async (store) => {
    const project = findProjectRecord(store, projectId);
    project.secrets ??= [];
    assertEnvNameAvailable(project, envName);
    const now = new Date().toISOString();
    const id = randomUUID();
    const stored: StoredProjectSecret = { id, projectId, envName, hostPattern, placeholder, annotation: values.annotation?.trim() ?? "", optional: values.optional ?? false, encryptedSecret: secretValue ? await encryptProjectValue(projectId, id, secretValue, keyFile) : undefined, createdAt: now, updatedAt: now };
    project.secrets.push(stored);
    return projectSecretSummary(stored);
  });
}

export async function updateProjectSecret(projectId: string, secretId: string, values: ProjectSecretInput, file = projectsFile(), keyFile?: string): Promise<ProjectSecretSummary> {
  const envName = normalizeEnvName(values.envName);
  const hostPattern = normalizeHostPattern(values.hostPattern);
  return await updateProjectStore(file, async (store) => {
    const project = findProjectRecord(store, projectId);
    const secret = findProjectSecret(project, secretId);
    assertEnvNameAvailable(project, envName, secretId);
    secret.envName = envName;
    secret.hostPattern = hostPattern;
    if (values.placeholder !== undefined) {
      const placeholder = normalizePlaceholder(values.placeholder);
      if (placeholder) secret.placeholder = placeholder;
      else delete secret.placeholder;
    }
    if (values.annotation !== undefined) secret.annotation = values.annotation.trim();
    if (values.optional !== undefined) secret.optional = values.optional;
    if (values.secretValue) secret.encryptedSecret = await encryptProjectValue(projectId, secretId, values.secretValue, keyFile);
    secret.updatedAt = new Date().toISOString();
    return projectSecretSummary(secret);
  });
}

export function projectSecretPlaceholder(name: string): string {
  return `ATELIER_PROXY_READY_${name.replaceAll(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`;
}

export function projectSecretHosts(pattern: string): string[] {
  return [...new Set(pattern.split(/[,;]/).map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

/** Binds a value-entry confirmation to the exact routing metadata the user reviewed. */
export function projectSecretRoutingRevision(secret: Pick<ProjectSecretSummary, "envName" | "hostPattern" | "placeholder">): string {
  return createHash("sha256").update(JSON.stringify([secret.envName.trim(), projectSecretHosts(secret.hostPattern).sort(), secret.placeholder?.trim() || projectSecretPlaceholder(secret.envName.trim())])).digest("hex");
}

export const projectSecretValueInputSchema = Type.Object({
  secretValue: Type.String({ minLength: 1, writeOnly: true }),
  expectedRoutingRevision: Type.String({ minLength: 1, description: "Routing confirmation from the secret-value dialog" }),
}, { additionalProperties: false });
export type ProjectSecretValueInput = Static<typeof projectSecretValueInputSchema>;

/** Value-only entry must not overwrite metadata that changed while its dialog was open. */
export async function setProjectSecretValue(projectId: string, secretId: string, input: ProjectSecretValueInput, file = projectsFile(), keyFile?: string): Promise<ProjectSecretSummary> {
  const { secretValue, expectedRoutingRevision } = input;
  if (!secretValue.trim()) throw new AtelierCoreError("invalid_arguments", "Enter a secret value");
  return updateProjectStore(file, async (store) => {
    const secret = findProjectSecret(findProjectRecord(store, projectId), secretId);
    if (projectSecretRoutingRevision(secret) !== expectedRoutingRevision) throw new AtelierCoreError("project_secret_routing_changed", "Secret destination or placeholder changed. Reopen the secret dialog and review its restrictions before saving.");
    secret.encryptedSecret = await encryptProjectValue(projectId, secretId, secretValue, keyFile);
    secret.updatedAt = new Date().toISOString();
    return projectSecretSummary(secret);
  });
}

export async function deleteProjectSecret(projectId: string, secretId: string, file = projectsFile()): Promise<ProjectSecretSummary> {
  return await updateProjectStore(file, (store) => {
    const project = findProjectRecord(store, projectId);
    const secret = findProjectSecret(project, secretId);
    project.secrets = project.secrets!.filter((candidate) => candidate !== secret);
    return projectSecretSummary(secret);
  });
}

export async function revealProjectSecrets(projectId: string, file = projectsFile(), keyFile?: string): Promise<ProjectSecretPlaintext[]> {
  const project = findProjectRecord(await readProjectStore(file), projectId);
  return await Promise.all((project.secrets ?? []).filter((secret) => secret.encryptedSecret).map(async (secret) => ({ ...projectSecretSummary(secret), secretValue: await decryptProjectValue(secret.projectId, secret.id, secret.encryptedSecret!, keyFile) })));
}
