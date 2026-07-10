import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { AtelierCoreError, getAtelierRuntimeContext } from "@atelier/core";
import { findProjectRecord, projectsFile, readProjectStore, writeProjectStore, type ProjectRecord, type ProjectSecretSummary, type StoredProjectSecret } from "./project.ts";

export interface ProjectSecretPlaintext extends ProjectSecretSummary {
  secretValue: string;
}

const keyBytes = 32;
const ivBytes = 12;

function projectSecretsKeyFile(dataDir = getAtelierRuntimeContext().atelierDataDir): string {
  return join(dataDir, "project-secrets.key");
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

async function readOrCreateMasterKey(file: string): Promise<Buffer> {
  try {
    const encoded = (await readFile(file, "utf8")).trim();
    const key = fromBase64Url(encoded);
    if (key.byteLength !== keyBytes) throw new AtelierCoreError("invalid_project_secret_key", `project secrets key must be ${keyBytes} bytes`);
    return key;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
    const key = randomBytes(keyBytes);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${base64Url(key)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
    return key;
  }
}

function aad(projectId: string, secretId: string): Buffer {
  return Buffer.from(`project-secret:${projectId}:${secretId}:v1`, "utf8");
}

async function encryptSecret(projectId: string, secretId: string, plaintext: string, keyFile = projectSecretsKeyFile()): Promise<string> {
  const key = await readOrCreateMasterKey(keyFile);
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(projectId, secretId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${base64Url(iv)}:${base64Url(Buffer.concat([ciphertext, tag]))}`;
}

async function decryptSecret(secret: StoredProjectSecret, keyFile = projectSecretsKeyFile()): Promise<string> {
  const [version, encodedIv, encodedPayload] = secret.encryptedSecret.split(":");
  if (version !== "v1" || !encodedIv || !encodedPayload) throw new AtelierCoreError("invalid_project_secret_ciphertext", `invalid project secret ciphertext: ${secret.id}`);
  const key = await readOrCreateMasterKey(keyFile);
  const payload = fromBase64Url(encodedPayload);
  if (payload.byteLength < 16) throw new AtelierCoreError("invalid_project_secret_ciphertext", `invalid project secret ciphertext: ${secret.id}`);
  const ciphertext = payload.subarray(0, payload.byteLength - 16);
  const tag = payload.subarray(payload.byteLength - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, fromBase64Url(encodedIv));
  decipher.setAAD(aad(secret.projectId, secret.id));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
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

function summary(secret: StoredProjectSecret): ProjectSecretSummary {
  const { encryptedSecret: _encryptedSecret, ...publicSecret } = secret;
  return publicSecret;
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
  return [...(project.secrets ?? [])]
    .sort((a, b) => a.envName.localeCompare(b.envName) || a.hostPattern.localeCompare(b.hostPattern))
    .map(summary);
}

export async function createProjectSecret(projectId: string, values: { envName: string; hostPattern: string; placeholder?: string; secretValue: string }, file = projectsFile(), keyFile = projectSecretsKeyFile()): Promise<ProjectSecretSummary> {
  const envName = normalizeEnvName(values.envName);
  const hostPattern = normalizeHostPattern(values.hostPattern);
  const placeholder = normalizePlaceholder(values.placeholder);
  const secretValue = values.secretValue;
  if (!secretValue) throw new AtelierCoreError("invalid_arguments", "SECRET is required");
  const store = await readProjectStore(file);
  const project = findProjectRecord(store, projectId);
  project.secrets ??= [];
  assertEnvNameAvailable(project, envName);
  const now = new Date().toISOString();
  const id = randomUUID();
  const stored: StoredProjectSecret = { id, projectId, envName, hostPattern, placeholder, encryptedSecret: await encryptSecret(projectId, id, secretValue, keyFile), createdAt: now, updatedAt: now };
  project.secrets!.push(stored);
  await writeProjectStore(file, store);
  return summary(stored);
}

export async function updateProjectSecret(projectId: string, secretId: string, values: { envName: string; hostPattern: string; placeholder?: string; secretValue?: string }, file = projectsFile(), keyFile = projectSecretsKeyFile()): Promise<ProjectSecretSummary> {
  const envName = normalizeEnvName(values.envName);
  const hostPattern = normalizeHostPattern(values.hostPattern);
  const store = await readProjectStore(file);
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
  if (values.secretValue) secret.encryptedSecret = await encryptSecret(projectId, secretId, values.secretValue, keyFile);
  secret.updatedAt = new Date().toISOString();
  await writeProjectStore(file, store);
  return summary(secret);
}

export async function deleteProjectSecret(projectId: string, secretId: string, file = projectsFile()): Promise<ProjectSecretSummary> {
  const store = await readProjectStore(file);
  const project = findProjectRecord(store, projectId);
  const secret = findProjectSecret(project, secretId);
  project.secrets = project.secrets!.filter((candidate) => candidate !== secret);
  await writeProjectStore(file, store);
  return summary(secret);
}

export async function revealProjectSecrets(projectId: string, file = projectsFile(), keyFile = projectSecretsKeyFile()): Promise<ProjectSecretPlaintext[]> {
  const project = findProjectRecord(await readProjectStore(file), projectId);
  return await Promise.all((project.secrets ?? []).map(async (secret) => ({ ...summary(secret), secretValue: await decryptSecret(secret, keyFile) })));
}
