import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtelierCoreError } from "@atelier/core";
import { decryptProjectValue, encryptProjectValue } from "./secret-crypto.ts";
import { findProjectRecord, projectsFile, readProjectStore, writeProjectStore, type ProjectSshKeySummary, type StoredProjectSshKey } from "./project.ts";

async function keyIdentity(privateKey: string): Promise<Pick<ProjectSshKeySummary, "keyType" | "fingerprint">> {
  const directory = await mkdtemp(join(tmpdir(), "atelier-ssh-key-"));
  const file = join(directory, "private-key");
  try {
    await writeFile(file, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, { mode: 0o600 });
    const process = Bun.spawn(["ssh-keygen", "-y", "-f", file], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [publicKey, stderr, status] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    if (status !== 0) throw new AtelierCoreError("invalid_ssh_private_key", stderr.trim() || "ssh-keygen rejected the private key; use an unencrypted OpenSSH private key");
    const [keyType, encodedKey] = publicKey.trim().split(/\s+/, 2);
    if (!keyType || !encodedKey) throw new AtelierCoreError("invalid_ssh_private_key", "ssh-keygen returned an invalid public key");
    const fingerprint = createHash("sha256").update(Buffer.from(encodedKey, "base64")).digest("base64").replace(/=+$/, "");
    return { keyType, fingerprint: `SHA256:${fingerprint}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function summary(key: StoredProjectSshKey): ProjectSshKeySummary {
  const { encryptedPrivateKey: _, ...result } = key;
  return result;
}

export async function listProjectSshKeys(projectId: string, file = projectsFile()): Promise<ProjectSshKeySummary[]> {
  const project = findProjectRecord(await readProjectStore(file), projectId);
  return (project.sshKeys ?? []).map(summary);
}

export async function createProjectSshKey(projectId: string, privateKey: string, file = projectsFile(), keyFile?: string): Promise<ProjectSshKeySummary> {
  if (!privateKey.trim()) throw new AtelierCoreError("invalid_arguments", "Private key is required");
  privateKey = privateKey.replace(/\r\n/g, "\n");
  const store = await readProjectStore(file);
  const project = findProjectRecord(store, projectId);
  const id = randomUUID();
  const key = {
    id,
    projectId,
    ...await keyIdentity(privateKey),
    createdAt: new Date().toISOString(),
    encryptedPrivateKey: await encryptProjectValue(projectId, id, privateKey, keyFile),
  };
  project.sshKeys ??= [];
  project.sshKeys.push(key);
  await writeProjectStore(file, store);
  return summary(key);
}

export async function deleteProjectSshKey(projectId: string, keyId: string, file = projectsFile()): Promise<ProjectSshKeySummary> {
  const store = await readProjectStore(file);
  const project = findProjectRecord(store, projectId);
  const keys = project.sshKeys ?? [];
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) throw new AtelierCoreError("project_ssh_key_not_found", "project SSH key not found");
  project.sshKeys = keys.filter((candidate) => candidate.id !== keyId);
  await writeProjectStore(file, store);
  return summary(key);
}

export async function revealProjectSshKeys(projectId: string, file = projectsFile(), keyFile?: string): Promise<string[]> {
  const project = findProjectRecord(await readProjectStore(file), projectId);
  return await Promise.all((project.sshKeys ?? []).map((key) => decryptProjectValue(projectId, key.id, key.encryptedPrivateKey, keyFile)));
}
